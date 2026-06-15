/**
 * backtest.ts — Walk-forward backtest for Phase 1.5 strategy.
 *
 * Simulates the FULL new strategy (regime filter + ADX corrected + circuit breaker)
 * on 6 months of historical 1h/4h Binance Futures data.
 *
 * Usage: npm run backtest
 * Requires: npm run fetch-historical first
 *
 * Walk-forward rules:
 *   - At candle i, only data up to candle i is visible (no look-ahead)
 *   - Entry at close of signal candle
 *   - SL/TP checked intrabar on subsequent candles (low/high)
 *   - TP1 = 50% partial close → SL moves to break-even → TP2 for remaining 50%
 *   - Fees: 0.05% per side (Binance maker)
 *   - Circuit breaker applied per tick (shared across symbols)
 */

import fs from 'fs'
import path from 'path'
import {
  ema, rsi, macd, atr as calcATR, bollingerBands, superTrend, adxFull, sma,
} from '../src/lib/strategy/indicators'

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT'] as const
type Symbol = typeof SYMBOLS[number]

const INITIAL_CAPITAL = 10_000   // USD
const RISK_PCT        = 0.01     // 1% risk per trade
const FEE_RATE        = 0.0005   // 0.05% per side (Binance maker)
const SL_ATR_MULT     = 2.2
const TP1_ATR_MULT    = 2.0
const TP2_ATR_MULT    = 3.5
const MIN_CANDLES     = 250      // warmup required by indicators
const MAX_DAILY_LOSS  = 0.05     // 5% daily loss limit
const ADX_MIN_REGIME  = 20       // ADX threshold for regime detection (4h)
const SLOPE_FLAT      = 0.5      // % EMA50 slope considered flat
const EMA_LOOKBACK_4H = 6        // 4h candles for slope measurement (~24h)
const DATA_DIR        = path.join(process.cwd(), 'data')

// Per-symbol 1h filters (mirrors signals.ts FILTERS_BY_SYMBOL)
const FILTERS: Record<Symbol, { adxMin: number; volMult: number }> = {
  BTCUSDT: { adxMin: 18, volMult: 0.9 },
  ETHUSDT: { adxMin: 20, volMult: 1.0 },
  BNBUSDT: { adxMin: 20, volMult: 1.0 },
  XRPUSDT: { adxMin: 20, volMult: 1.0 },
  SOLUSDT: { adxMin: 25, volMult: 1.2 },
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Candle {
  openTime: number; open: number; high: number
  low: number; close: number; volume: number; closeTime: number
}

type Regime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'TRANSITION'
type Direction = 'LONG' | 'SHORT'
type CloseReason = 'SL' | 'TP1+BE' | 'TP2' | 'END'

interface OpenPosition {
  symbol: Symbol
  direction: Direction
  entryPrice: number
  entryCandle: number       // 1h candle index
  sl: number                // mutable — moves to break-even after TP1
  tp1: number
  tp2: number
  qty: number               // asset units (full position)
  tp1Hit: boolean
  tp1BookedPnlUsd: number   // partial PnL booked when TP1 hit (before fees)
  regime: Regime
  sizeMultiplier: number
}

interface ClosedTrade {
  symbol: Symbol
  direction: Direction
  entryPrice: number
  exitPrice: number
  closeReason: CloseReason
  pnlUsd: number            // net (after fees)
  closeTime: number         // epoch ms (candle closeTime)
  regime: Regime
  sizeMultiplier: number
}

// ─── Precomputed series per symbol ───────────────────────────────────────────

interface SymbolSeries {
  // 1h arrays (length = candles1h.length)
  rsi1h:       number[]
  macdHist1h:  number[]
  atr1h:       number[]
  stDir1h:     ('UP' | 'DOWN')[]
  volSMA1h:    number[]
  adx1h:       number[]
  // 4h arrays (length = candles4h.length)
  adx4h:       number[]
  diPlus4h:    number[]
  diMinus4h:   number[]
  ema50_4h:    number[]
  // Alignment: for each 1h index i → last fully-closed 4h index j
  align4h:     number[]
}

function precompute(c1h: Candle[], c4h: Candle[]): SymbolSeries {
  const cl1h = c1h.map(c => c.close)
  const cl4h = c4h.map(c => c.close)
  const vol1h = c1h.map(c => c.volume)

  const rsi1h      = rsi(cl1h, 14)
  const { histogram: macdHist1h } = macd(cl1h, 12, 26, 9)
  const atr1h      = calcATR(c1h, 14)
  const { directions: stDir1h } = superTrend(c1h, 7, 3)
  const volSMA1h   = sma(vol1h, 20)
  const { adx: adx1h } = adxFull(c1h, 14)

  const { adx: adx4h, diPlus: diPlus4h, diMinus: diMinus4h } = adxFull(c4h, 14)
  const ema50_4h   = ema(cl4h, 50)

  // For each 1h candle i, find the last 4h candle j whose closeTime ≤ 1h[i].closeTime.
  // This is the "available information" at candle i — no look-ahead into open 4h candles.
  const align4h = new Array<number>(c1h.length).fill(0)
  let j4 = 0
  for (let i = 0; i < c1h.length; i++) {
    while (j4 + 1 < c4h.length && c4h[j4 + 1].closeTime <= c1h[i].closeTime) j4++
    align4h[i] = j4
  }

  return { rsi1h, macdHist1h, atr1h, stDir1h, volSMA1h, adx1h,
           adx4h, diPlus4h, diMinus4h, ema50_4h, align4h }
}

// ─── Regime detection (inline — mirrors regime.ts analyzeRegime) ──────────────

function detectRegime(
  s: SymbolSeries,
  j: number,  // 4h index
): { regime: Regime; allowLong: boolean; allowShort: boolean } {
  const adxV  = s.adx4h[j]
  const dip   = s.diPlus4h[j]
  const dim   = s.diMinus4h[j]
  const e50   = s.ema50_4h[j]
  const e50p  = j >= EMA_LOOKBACK_4H ? s.ema50_4h[j - EMA_LOOKBACK_4H] : NaN

  if (isNaN(adxV) || isNaN(dip) || isNaN(dim)) {
    return { regime: 'RANGING', allowLong: false, allowShort: false }
  }
  if (adxV < ADX_MIN_REGIME) {
    return { regime: 'RANGING', allowLong: false, allowShort: false }
  }

  const slope = (!isNaN(e50p) && e50p > 0) ? (e50 - e50p) / e50p * 100 : 0
  const diBull = dip > dim
  const sBull  = slope >  SLOPE_FLAT
  const sBear  = slope < -SLOPE_FLAT

  if (diBull && sBull)    return { regime: 'TRENDING_UP',   allowLong: true,  allowShort: false }
  if (!diBull && sBear)   return { regime: 'TRENDING_DOWN', allowLong: false, allowShort: true  }
  return { regime: 'TRANSITION', allowLong: false, allowShort: false }
}

// ─── Signal detection (inline — mirrors generateSignal logic) ─────────────────

interface SignalResult {
  direction: Direction
  atr: number
  regime: Regime
}

function detectSignal(
  sym: Symbol,
  s: SymbolSeries,
  i: number,   // 1h index
  j: number,   // aligned 4h index
  candle: Candle,
): SignalResult | null {
  // Require both 1h and 4h have enough warmup
  if (i < MIN_CANDLES - 1 || j < MIN_CANDLES - 1) return null

  // Any NaN indicator → skip
  const rsiV    = s.rsi1h[i]
  const histV   = s.macdHist1h[i]
  const histPV  = s.macdHist1h[i - 1]
  const atrV    = s.atr1h[i]
  const stV     = s.stDir1h[i]
  const volV    = candle.volume
  const volMA   = s.volSMA1h[i]
  const adx1V   = s.adx1h[i]

  if ([rsiV, histV, histPV, atrV, volMA, adx1V].some(isNaN) || atrV === 0) return null

  const { regime, allowLong, allowShort } = detectRegime(s, j)
  if (!allowLong && !allowShort) return null

  const f = FILTERS[sym]
  const macdBull = histV > 0 && histV > histPV
  const macdBear = histV < 0 && histV < histPV
  const rsiLong  = rsiV >= 40 && rsiV <= 68
  const rsiShort = rsiV >= 32 && rsiV <= 60
  const stBull   = stV === 'UP'
  const stBear   = stV === 'DOWN'
  const volOK    = volV >= volMA * f.volMult
  const adxOK    = adx1V > f.adxMin

  const isLong  = allowLong  && macdBull && rsiLong  && stBull && volOK && adxOK
  const isShort = allowShort && macdBear && rsiShort && stBear && volOK && adxOK

  if (!isLong && !isShort) return null
  return { direction: isLong ? 'LONG' : 'SHORT', atr: atrV, regime }
}

// ─── Circuit breaker (inline — mirrors evaluateCircuitBreaker from risk.ts) ────

interface CBState {
  action: 'NONE' | 'REDUCE_SIZE' | 'PAUSE_DIRECTION' | 'PAUSE_ALL'
  sizeMultiplier: number
  pausedDirection?: Direction
  pauseUntil?: number   // epoch ms (using candle time, not wall clock)
}

function calcCB(
  recent: ClosedTrade[],   // already filtered to last 24h candle-time
  capital: number,
  currentTime: number,
): CBState {
  const sorted = [...recent].sort((a, b) => b.closeTime - a.closeTime)

  let consecutive = 0
  for (const t of sorted) {
    if (t.pnlUsd < 0) consecutive++
    else break
  }

  const dailyLoss = recent.filter(t => t.pnlUsd < 0).reduce((s, t) => s + Math.abs(t.pnlUsd), 0)
  const lossPct = capital > 0 ? dailyLoss / capital : 0

  // Tier 3: daily loss limit
  if (lossPct >= MAX_DAILY_LOSS) {
    const midnight = new Date(currentTime)
    midnight.setUTCHours(24, 0, 0, 0)
    return { action: 'PAUSE_ALL', sizeMultiplier: 0, pauseUntil: midnight.getTime() }
  }

  // Tier 2: 3 consecutive in same direction
  if (consecutive >= 3) {
    const lastDir = sorted[0].direction
    const sameDir = sorted.slice(0, 3).every(t => t.direction === lastDir)
    if (sameDir) {
      const pauseUntil = sorted[2].closeTime + 6 * 3600 * 1000
      return { action: 'PAUSE_DIRECTION', sizeMultiplier: 0.5, pausedDirection: lastDir, pauseUntil }
    }
  }

  // Tier 1: 2 consecutive
  if (consecutive >= 2) {
    return { action: 'REDUCE_SIZE', sizeMultiplier: 0.5 }
  }

  return { action: 'NONE', sizeMultiplier: 1.0 }
}

// ─── Position management ─────────────────────────────────────────────────────

function openPosition(
  sym: Symbol,
  candle: Candle,
  i: number,
  sig: SignalResult,
  equity: number,
  sizeMultiplier: number,
): OpenPosition {
  const dir = sig.direction === 'LONG' ? 1 : -1
  const entry = candle.close
  const sl    = entry - dir * sig.atr * SL_ATR_MULT
  const tp1   = entry + dir * sig.atr * TP1_ATR_MULT
  const tp2   = entry + dir * sig.atr * TP2_ATR_MULT
  const riskUsd = equity * RISK_PCT * sizeMultiplier
  const slDist = Math.abs(entry - sl)
  const qty = slDist > 0 ? riskUsd / slDist : 0
  return { symbol: sym, direction: sig.direction, entryPrice: entry, entryCandle: i,
           sl, tp1, tp2, qty, tp1Hit: false, tp1BookedPnlUsd: 0,
           regime: sig.regime, sizeMultiplier }
}

// Returns a closed trade if the position is FULLY closed on this candle, else null.
// Mutates pos.sl and pos.tp1Hit when TP1 is hit (position stays open).
function checkExitOnCandle(pos: OpenPosition, candle: Candle): ClosedTrade | null {
  const dir = pos.direction === 'LONG' ? 1 : -1
  const { high: hi, low: lo, closeTime } = candle

  const slHit  = pos.direction === 'LONG' ? lo <= pos.sl  : hi >= pos.sl
  const tp1Hit = !pos.tp1Hit && (pos.direction === 'LONG' ? hi >= pos.tp1 : lo <= pos.tp1)

  if (!pos.tp1Hit) {
    // If both SL and TP1 hit on the same candle, conservative: SL wins
    if (slHit) {
      const gross = (pos.sl - pos.entryPrice) * dir * pos.qty
      const fees  = (pos.entryPrice + pos.sl) * pos.qty * FEE_RATE
      return buildTrade(pos, pos.sl, 'SL', gross - fees, closeTime)
    }
    if (tp1Hit) {
      // Partial close: 50% at TP1, move SL to break-even
      const gross50 = (pos.tp1 - pos.entryPrice) * dir * pos.qty * 0.5
      pos.tp1BookedPnlUsd = gross50
      pos.tp1Hit = true
      pos.sl = pos.entryPrice  // break-even
    }
  }

  if (pos.tp1Hit) {
    const beOrSlHit = pos.direction === 'LONG' ? lo <= pos.sl : hi >= pos.sl
    const tp2Hit    = pos.direction === 'LONG' ? hi >= pos.tp2 : lo <= pos.tp2

    const exitReason: CloseReason = tp2Hit ? 'TP2' : beOrSlHit ? 'TP1+BE' : null!
    if (!tp2Hit && !beOrSlHit) return null  // still open

    const exitPrice = tp2Hit ? pos.tp2 : pos.sl
    const gross50r  = (exitPrice - pos.entryPrice) * dir * pos.qty * 0.5
    const entryFee  = pos.entryPrice * pos.qty * FEE_RATE
    const tp1Fee    = pos.tp1 * pos.qty * 0.5 * FEE_RATE
    const exitFee   = exitPrice * pos.qty * 0.5 * FEE_RATE
    const netPnl    = pos.tp1BookedPnlUsd + gross50r - entryFee - tp1Fee - exitFee
    return buildTrade(pos, exitPrice, exitReason, netPnl, closeTime)
  }

  return null
}

function buildTrade(
  pos: OpenPosition, exitPrice: number, reason: CloseReason, pnlUsd: number, closeTime: number,
): ClosedTrade {
  return {
    symbol: pos.symbol, direction: pos.direction,
    entryPrice: pos.entryPrice, exitPrice,
    closeReason: reason, pnlUsd,
    closeTime, regime: pos.regime, sizeMultiplier: pos.sizeMultiplier,
  }
}

// Force-close a position at the last available candle
function forceClose(pos: OpenPosition, candle: Candle): ClosedTrade {
  const dir = pos.direction === 'LONG' ? 1 : -1
  const exitPrice = candle.close
  let pnlUsd: number
  if (pos.tp1Hit) {
    const gross50r = (exitPrice - pos.entryPrice) * dir * pos.qty * 0.5
    const entryFee = pos.entryPrice * pos.qty * FEE_RATE
    const tp1Fee   = pos.tp1 * pos.qty * 0.5 * FEE_RATE
    const exitFee  = exitPrice * pos.qty * 0.5 * FEE_RATE
    pnlUsd = pos.tp1BookedPnlUsd + gross50r - entryFee - tp1Fee - exitFee
  } else {
    const gross = (exitPrice - pos.entryPrice) * dir * pos.qty
    const fees  = (pos.entryPrice + exitPrice) * pos.qty * FEE_RATE
    pnlUsd = gross - fees
  }
  return buildTrade(pos, exitPrice, 'END', pnlUsd, candle.closeTime)
}

// ─── Data loading ─────────────────────────────────────────────────────────────

function loadCandles(symbol: string, interval: string): Candle[] {
  const file = path.join(DATA_DIR, `${symbol}_${interval}.json`)
  if (!fs.existsSync(file)) {
    throw new Error(`Missing: ${file}\nRun "npm run fetch-historical" first.`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Candle[]
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

interface Stats {
  trades: number
  wins: number
  totalWinPnl: number
  totalLossPnl: number  // absolute value
}

function addStats(s: Stats, t: ClosedTrade) {
  s.trades++
  if (t.pnlUsd >= 0) { s.wins++; s.totalWinPnl += t.pnlUsd }
  else s.totalLossPnl += Math.abs(t.pnlUsd)
}

function winRate(s: Stats)      { return s.trades > 0 ? s.wins / s.trades : 0 }
function profitFactor(s: Stats) { return s.totalLossPnl > 0 ? s.totalWinPnl / s.totalLossPnl : Infinity }

function maxDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0]
  let maxDD = 0
  for (const v of equityCurve) {
    if (v > peak) peak = v
    const dd = (peak - v) / peak
    if (dd > maxDD) maxDD = dd
  }
  return maxDD
}

function maxConsecLosses(trades: ClosedTrade[]): number {
  let max = 0, cur = 0
  for (const t of trades) {
    if (t.pnlUsd < 0) { cur++; if (cur > max) max = cur }
    else cur = 0
  }
  return max
}

function miniChart(curve: number[], cols = 60): string {
  if (curve.length < 2) return '(no data)'
  const step = Math.max(1, Math.floor(curve.length / cols))
  const sampled = Array.from({ length: cols }, (_, k) => curve[Math.min(k * step, curve.length - 1)])
  const lo = Math.min(...sampled), hi = Math.max(...sampled)
  const range = hi - lo || 1
  const rows = 5
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '))
  for (let c = 0; c < cols; c++) {
    const row = Math.round((1 - (sampled[c] - lo) / range) * (rows - 1))
    grid[row][c] = sampled[c] >= curve[0] ? '▲' : '▼'
  }
  return grid.map(r => '  │' + r.join('') + '│').join('\n')
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════')
  console.log('  BACKTEST — Phase 1.5 Strategy (regime + ADX fix + CB)')
  console.log('══════════════════════════════════════════════════════════\n')

  // Load and precompute
  const data: Record<string, { c1h: Candle[]; c4h: Candle[]; s: SymbolSeries }> = {}
  for (const sym of SYMBOLS) {
    process.stdout.write(`  Loading ${sym}...`)
    try {
      const c1h = loadCandles(sym, '1h')
      const c4h = loadCandles(sym, '4h')
      const s   = precompute(c1h, c4h)
      data[sym] = { c1h, c4h, s }
      console.log(` ${c1h.length} × 1h, ${c4h.length} × 4h`)
    } catch (e) {
      console.error(`\n  ERROR: ${e instanceof Error ? e.message : e}`)
      process.exit(1)
    }
  }

  const maxLen = Math.max(...SYMBOLS.map(sym => data[sym].c1h.length))
  const positions: Record<string, OpenPosition | null> = {}
  for (const sym of SYMBOLS) positions[sym] = null

  const allClosed: ClosedTrade[] = []
  let equity = INITIAL_CAPITAL
  const equityCurve: number[] = [equity]

  // Per-symbol stats
  const symStats: Record<string, Stats> = {}
  for (const sym of SYMBOLS) symStats[sym] = { trades: 0, wins: 0, totalWinPnl: 0, totalLossPnl: 0 }

  // Direction / regime breakdown
  const dirStats: Record<Direction, Stats> = {
    LONG:  { trades: 0, wins: 0, totalWinPnl: 0, totalLossPnl: 0 },
    SHORT: { trades: 0, wins: 0, totalWinPnl: 0, totalLossPnl: 0 },
  }
  const regStats: Record<string, Stats> = {}

  // ── Walk-forward ────────────────────────────────────────────────────────────

  for (let i = 0; i < maxLen; i++) {
    // Pick reference time from the first available symbol at this index
    const refSym = SYMBOLS.find(sym => i < data[sym].c1h.length)
    if (!refSym) break
    const currentTime = data[refSym].c1h[i].closeTime

    // 1. Check SL/TP on open positions
    for (const sym of SYMBOLS) {
      const pos = positions[sym]
      if (!pos || i >= data[sym].c1h.length) continue
      const candle = data[sym].c1h[i]
      if (i <= pos.entryCandle) continue  // don't check exit on entry candle

      const closed = checkExitOnCandle(pos, candle)
      if (closed) {
        positions[sym] = null
        allClosed.push(closed)
        equity += closed.pnlUsd
        addStats(symStats[sym], closed)
        addStats(dirStats[closed.direction], closed)
        if (!regStats[closed.regime]) {
          regStats[closed.regime] = { trades: 0, wins: 0, totalWinPnl: 0, totalLossPnl: 0 }
        }
        addStats(regStats[closed.regime], closed)
      }
    }

    // 2. Compute circuit breaker from last 24h of closed trades
    const dayAgo  = currentTime - 24 * 3600 * 1000
    const recent  = allClosed.filter(t => t.closeTime > dayAgo)
    const cbState = calcCB(recent, equity, currentTime)

    // 3. Try to open new positions
    if (cbState.action !== 'PAUSE_ALL') {
      for (const sym of SYMBOLS) {
        if (positions[sym]) continue  // already in position
        if (i >= data[sym].c1h.length) continue

        const candle = data[sym].c1h[i]
        const j = data[sym].s.align4h[i]
        const sig = detectSignal(sym, data[sym].s, i, j, candle)
        if (!sig) continue

        // Apply directional pause
        if (
          cbState.action === 'PAUSE_DIRECTION' &&
          cbState.pausedDirection === sig.direction &&
          cbState.pauseUntil !== undefined &&
          currentTime < cbState.pauseUntil
        ) continue

        positions[sym] = openPosition(sym, candle, i, sig, equity, cbState.sizeMultiplier)
      }
    }

    equityCurve.push(equity)
  }

  // Force-close any remaining open positions at last candle
  for (const sym of SYMBOLS) {
    const pos = positions[sym]
    if (!pos) continue
    const lastIdx = data[sym].c1h.length - 1
    const lastCandle = data[sym].c1h[lastIdx]
    const closed = forceClose(pos, lastCandle)
    allClosed.push(closed)
    equity += closed.pnlUsd
    addStats(symStats[sym], closed)
    addStats(dirStats[closed.direction], closed)
    if (!regStats[closed.regime]) {
      regStats[closed.regime] = { trades: 0, wins: 0, totalWinPnl: 0, totalLossPnl: 0 }
    }
    addStats(regStats[closed.regime], closed)
  }
  equityCurve.push(equity)

  // ── Report ───────────────────────────────────────────────────────────────────

  const total: Stats = { trades: 0, wins: 0, totalWinPnl: 0, totalLossPnl: 0 }
  for (const sym of SYMBOLS) {
    const s = symStats[sym]
    total.trades     += s.trades
    total.wins       += s.wins
    total.totalWinPnl  += s.totalWinPnl
    total.totalLossPnl += s.totalLossPnl
  }

  const dd   = maxDrawdown(equityCurve)
  const mcl  = maxConsecLosses(allClosed)
  const pnlUsd = equity - INITIAL_CAPITAL
  const pnlPct = pnlUsd / INITIAL_CAPITAL * 100

  const fmt = (n: number, dec = 1) => n.toFixed(dec)
  const pct  = (n: number) => `${(n * 100).toFixed(1)}%`

  console.log('\n── Per-symbol ──────────────────────────────────────────────')
  for (const sym of SYMBOLS) {
    const s = symStats[sym]
    if (s.trades === 0) { console.log(`  ${sym}: 0 trades`); continue }
    console.log(
      `  ${sym}: ${s.trades} trades | WR ${pct(winRate(s))} | PF ${fmt(profitFactor(s), 2)}`
    )
  }

  console.log('\n── Combined ────────────────────────────────────────────────')
  console.log(`  Total trades:     ${total.trades}`)
  console.log(`  Win rate:         ${pct(winRate(total))}`)
  console.log(`  Profit factor:    ${fmt(profitFactor(total), 2)}`)
  console.log(`  Max drawdown:     ${pct(dd)}`)
  console.log(`  Max consec. loss: ${mcl}`)
  console.log(`  Final equity:     $${fmt(equity, 0)} (${pnlPct >= 0 ? '+' : ''}${fmt(pnlPct)}%)`)

  console.log('\n── Direction breakdown ─────────────────────────────────────')
  for (const dir of ['LONG', 'SHORT'] as Direction[]) {
    const s = dirStats[dir]
    if (s.trades === 0) { console.log(`  ${dir}: 0 trades`); continue }
    const pf = profitFactor(s)
    console.log(
      `  ${dir}: ${s.trades} trades (${pct(s.trades / total.trades)})` +
      ` | WR ${pct(winRate(s))} | PF ${pf === Infinity ? '∞' : fmt(pf, 2)}`
    )
  }

  console.log('\n── Regime breakdown ────────────────────────────────────────')
  for (const [reg, s] of Object.entries(regStats).sort((a, b) => b[1].trades - a[1].trades)) {
    const pf = profitFactor(s)
    console.log(
      `  ${reg.padEnd(16)}: ${String(s.trades).padStart(4)} trades` +
      ` | WR ${pct(winRate(s))} | PF ${pf === Infinity ? '  ∞' : fmt(pf, 2)}`
    )
  }
  const transCount = regStats['TRANSITION']?.trades ?? 0
  const rangCount  = regStats['RANGING']?.trades ?? 0
  if (transCount === 0) console.log('  TRANSITION: 0 trades ✓ (filter working)')
  if (rangCount  === 0) console.log('  RANGING:    0 trades ✓ (filter working)')

  console.log('\n── Equity curve ────────────────────────────────────────────')
  console.log(miniChart(equityCurve))
  console.log(`  Start: $${INITIAL_CAPITAL}  →  End: $${fmt(equity, 0)}`)

  // ── Spec criteria (Section 8.3) ──────────────────────────────────────────────
  console.log('\n── Spec 8.3 validation ─────────────────────────────────────')
  const longPct = total.trades > 0 ? dirStats.LONG.trades / total.trades : 0
  const wr      = winRate(total)
  const pf      = profitFactor(total)

  const check = (ok: boolean, msg: string) => console.log(`  [${ok ? '✓' : '✗'}] ${msg}`)

  check(dirStats.LONG.trades > 0,       `LONGs generated: ${dirStats.LONG.trades} trades`)
  check(wr >= 0.42,                     `Win rate: ${pct(wr)} (target ≥ 42%)`)
  check(pf >= 1.25,                     `Profit factor: ${fmt(pf, 2)} (target ≥ 1.25)`)
  check(transCount === 0,               `TRANSITION trades: ${transCount} (target = 0)`)
  check(dd <= 0.15,                     `Max drawdown: ${pct(dd)} (target ≤ 15%)`)
  check(longPct >= 0.2 && longPct <= 0.8,
        `LONG/SHORT balance: ${pct(longPct)} LONG (target 20-80%)`)

  const allPass = dirStats.LONG.trades > 0 && wr >= 0.42 && pf >= 1.25 &&
                  transCount === 0 && dd <= 0.15 && longPct >= 0.2 && longPct <= 0.8
  console.log(`\n  ${allPass ? '✅ ALL CRITERIA PASSED — ready for shadow re-validation' : '❌ Some criteria failed — iterate parameters before redeploy'}`)
  console.log()
}

main().catch(err => { console.error(err); process.exit(1) })
