/**
 * engine.ts — shared backtest engine, extracted from backtest.ts so that
 * backtest.ts, test20 (bull month) and test22 (SL noise old-vs-new) all
 * simulate against the exact same logic instead of three drifting copies.
 */

import fs from 'fs'
import path from 'path'
import {
  ema, rsi, macd, atr as calcATR, superTrend, adxFull, sma,
} from '../../src/lib/strategy/indicators'

// ─── Config ───────────────────────────────────────────────────────────────────

export const FEE_RATE        = 0.0005   // 0.05% per side (Binance maker)
export const MIN_CANDLES     = 250      // warmup required by indicators
export const MAX_DAILY_LOSS  = 0.05     // 5% daily loss limit
export const ADX_MIN_REGIME  = 20       // ADX threshold for regime detection (4h)
export const SLOPE_FLAT      = 0.5      // % EMA50 slope considered flat
export const EMA_LOOKBACK_4H = 6        // 4h candles for slope measurement (~24h)
export const DATA_DIR        = path.join(process.cwd(), 'data')

export interface StrategyConfig {
  slAtrMult: number
  tp1AtrMult: number
  tp2AtrMult: number
}

// Current (Phase 1.5) strategy — regime filter + corrected ADX + recalibrated SL/TP
export const NEW_STRATEGY: StrategyConfig = { slAtrMult: 2.2, tp1AtrMult: 2.0, tp2AtrMult: 3.5 }

// Pre-fix strategy — only the SL/TP distances from before Phase 1.5 (P3 in the spec).
// Regime/ADX stay on the corrected logic; only the ATR multipliers change, since
// Test 22 isolates that one variable (a fair "old vs new" requires re-running the
// broken ADX too, but that conflates two fixes — the SL-noise question is specifically
// about stop distance).
export const OLD_STRATEGY: StrategyConfig = { slAtrMult: 1.5, tp1AtrMult: 2.5, tp2AtrMult: 4.0 }

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT'] as const
export type Symbol = typeof SYMBOLS[number]

export const FILTERS: Record<Symbol, { adxMin: number; volMult: number }> = {
  BTCUSDT: { adxMin: 18, volMult: 0.9 },
  ETHUSDT: { adxMin: 20, volMult: 1.0 },
  BNBUSDT: { adxMin: 20, volMult: 1.0 },
  XRPUSDT: { adxMin: 20, volMult: 1.0 },
  SOLUSDT: { adxMin: 25, volMult: 1.2 },
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Candle {
  openTime: number; open: number; high: number
  low: number; close: number; volume: number; closeTime: number
}

export type Regime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'TRANSITION'
export type Direction = 'LONG' | 'SHORT'
export type CloseReason = 'SL' | 'TP1+BE' | 'TP2' | 'END'

export interface OpenPosition {
  symbol: Symbol
  direction: Direction
  entryPrice: number
  entryCandle: number
  entryTime: number
  sl: number
  tp1: number
  tp2: number
  qty: number
  tp1Hit: boolean
  tp1BookedPnlUsd: number
  regime: Regime
  sizeMultiplier: number
}

export interface ClosedTrade {
  symbol: Symbol
  direction: Direction
  entryPrice: number
  entryTime: number
  exitPrice: number
  closeReason: CloseReason
  pnlUsd: number
  closeTime: number
  regime: Regime
  sizeMultiplier: number
  /** ms from entry to first SL/BE/TP touch — used by Test 22 to measure noise stop-outs */
  holdingMs: number
}

export interface SymbolSeries {
  rsi1h:       number[]
  macdHist1h:  number[]
  atr1h:       number[]
  stDir1h:     ('UP' | 'DOWN')[]
  volSMA1h:    number[]
  adx1h:       number[]
  adx4h:       number[]
  diPlus4h:    number[]
  diMinus4h:   number[]
  ema50_4h:    number[]
  align4h:     number[]
}

// ─── Precompute ───────────────────────────────────────────────────────────────

export function precompute(c1h: Candle[], c4h: Candle[]): SymbolSeries {
  const cl1h = c1h.map(c => c.close)
  const cl4h = c4h.map(c => c.close)
  const vol1h = c1h.map(c => c.volume)

  const rsi1h     = rsi(cl1h, 14)
  const { histogram: macdHist1h } = macd(cl1h, 12, 26, 9)
  const atr1h     = calcATR(c1h, 14)
  const { directions: stDir1h } = superTrend(c1h, 7, 3)
  const volSMA1h  = sma(vol1h, 20)
  const { adx: adx1h } = adxFull(c1h, 14)

  const { adx: adx4h, diPlus: diPlus4h, diMinus: diMinus4h } = adxFull(c4h, 14)
  const ema50_4h  = ema(cl4h, 50)

  const align4h = new Array<number>(c1h.length).fill(0)
  let j4 = 0
  for (let i = 0; i < c1h.length; i++) {
    while (j4 + 1 < c4h.length && c4h[j4 + 1].closeTime <= c1h[i].closeTime) j4++
    align4h[i] = j4
  }

  return { rsi1h, macdHist1h, atr1h, stDir1h, volSMA1h, adx1h,
           adx4h, diPlus4h, diMinus4h, ema50_4h, align4h }
}

// ─── Regime + signal detection ─────────────────────────────────────────────────

export function detectRegime(
  s: SymbolSeries, j: number,
): { regime: Regime; allowLong: boolean; allowShort: boolean } {
  const adxV = s.adx4h[j], dip = s.diPlus4h[j], dim = s.diMinus4h[j]
  const e50  = s.ema50_4h[j]
  const e50p = j >= EMA_LOOKBACK_4H ? s.ema50_4h[j - EMA_LOOKBACK_4H] : NaN

  if (isNaN(adxV) || isNaN(dip) || isNaN(dim)) {
    return { regime: 'RANGING', allowLong: false, allowShort: false }
  }
  if (adxV < ADX_MIN_REGIME) {
    return { regime: 'RANGING', allowLong: false, allowShort: false }
  }

  const slope = (!isNaN(e50p) && e50p > 0) ? (e50 - e50p) / e50p * 100 : 0
  const diBull = dip > dim
  const sBull = slope > SLOPE_FLAT
  const sBear = slope < -SLOPE_FLAT

  if (diBull && sBull)  return { regime: 'TRENDING_UP',   allowLong: true,  allowShort: false }
  if (!diBull && sBear) return { regime: 'TRENDING_DOWN', allowLong: false, allowShort: true  }
  return { regime: 'TRANSITION', allowLong: false, allowShort: false }
}

export interface SignalResult {
  direction: Direction
  atr: number
  regime: Regime
}

export function detectSignal(
  sym: Symbol, s: SymbolSeries, i: number, j: number, candle: Candle,
): SignalResult | null {
  if (i < MIN_CANDLES - 1 || j < MIN_CANDLES - 1) return null

  const rsiV   = s.rsi1h[i]
  const histV  = s.macdHist1h[i]
  const histPV = s.macdHist1h[i - 1]
  const atrV   = s.atr1h[i]
  const stV    = s.stDir1h[i]
  const volMA  = s.volSMA1h[i]
  const adx1V  = s.adx1h[i]

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
  const volOK    = candle.volume >= volMA * f.volMult
  const adxOK    = adx1V > f.adxMin

  const isLong  = allowLong  && macdBull && rsiLong  && stBull && volOK && adxOK
  const isShort = allowShort && macdBear && rsiShort && stBear && volOK && adxOK

  if (!isLong && !isShort) return null
  return { direction: isLong ? 'LONG' : 'SHORT', atr: atrV, regime }
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

export interface CBState {
  action: 'NONE' | 'REDUCE_SIZE' | 'PAUSE_DIRECTION' | 'PAUSE_ALL'
  sizeMultiplier: number
  pausedDirection?: Direction
  pauseUntil?: number
}

export function calcCB(recent: ClosedTrade[], capital: number, currentTime: number): CBState {
  const sorted = [...recent].sort((a, b) => b.closeTime - a.closeTime)

  let consecutive = 0
  for (const t of sorted) {
    if (t.pnlUsd < 0) consecutive++
    else break
  }

  const dailyLoss = recent.filter(t => t.pnlUsd < 0).reduce((sum, t) => sum + Math.abs(t.pnlUsd), 0)
  const lossPct = capital > 0 ? dailyLoss / capital : 0

  if (lossPct >= MAX_DAILY_LOSS) {
    const midnight = new Date(currentTime)
    midnight.setUTCHours(24, 0, 0, 0)
    return { action: 'PAUSE_ALL', sizeMultiplier: 0, pauseUntil: midnight.getTime() }
  }

  if (consecutive >= 3) {
    const lastDir = sorted[0].direction
    const sameDir = sorted.slice(0, 3).every(t => t.direction === lastDir)
    if (sameDir) {
      const pauseUntil = sorted[2].closeTime + 6 * 3600 * 1000
      return { action: 'PAUSE_DIRECTION', sizeMultiplier: 0.5, pausedDirection: lastDir, pauseUntil }
    }
  }

  if (consecutive >= 2) return { action: 'REDUCE_SIZE', sizeMultiplier: 0.5 }
  return { action: 'NONE', sizeMultiplier: 1.0 }
}

// ─── Position management ─────────────────────────────────────────────────────

export function openPosition(
  sym: Symbol, candle: Candle, i: number, sig: SignalResult,
  equity: number, sizeMultiplier: number, cfg: StrategyConfig, riskPct: number,
): OpenPosition {
  const dir = sig.direction === 'LONG' ? 1 : -1
  const entry = candle.close
  const sl  = entry - dir * sig.atr * cfg.slAtrMult
  const tp1 = entry + dir * sig.atr * cfg.tp1AtrMult
  const tp2 = entry + dir * sig.atr * cfg.tp2AtrMult
  const riskUsd = equity * riskPct * sizeMultiplier
  const slDist = Math.abs(entry - sl)
  const qty = slDist > 0 ? riskUsd / slDist : 0
  return { symbol: sym, direction: sig.direction, entryPrice: entry, entryCandle: i,
           entryTime: candle.closeTime, sl, tp1, tp2, qty, tp1Hit: false, tp1BookedPnlUsd: 0,
           regime: sig.regime, sizeMultiplier }
}

export function checkExitOnCandle(pos: OpenPosition, candle: Candle): ClosedTrade | null {
  const dir = pos.direction === 'LONG' ? 1 : -1
  const { high: hi, low: lo, closeTime } = candle

  const slHit  = pos.direction === 'LONG' ? lo <= pos.sl  : hi >= pos.sl
  const tp1Hit = !pos.tp1Hit && (pos.direction === 'LONG' ? hi >= pos.tp1 : lo <= pos.tp1)

  if (!pos.tp1Hit) {
    if (slHit) {
      const gross = (pos.sl - pos.entryPrice) * dir * pos.qty
      const fees  = (pos.entryPrice + pos.sl) * pos.qty * FEE_RATE
      return buildTrade(pos, pos.sl, 'SL', gross - fees, closeTime)
    }
    if (tp1Hit) {
      const gross50 = (pos.tp1 - pos.entryPrice) * dir * pos.qty * 0.5
      pos.tp1BookedPnlUsd = gross50
      pos.tp1Hit = true
      pos.sl = pos.entryPrice
    }
  }

  if (pos.tp1Hit) {
    const beOrSlHit = pos.direction === 'LONG' ? lo <= pos.sl : hi >= pos.sl
    const tp2Hit    = pos.direction === 'LONG' ? hi >= pos.tp2 : lo <= pos.tp2

    if (!tp2Hit && !beOrSlHit) return null

    const exitReason: CloseReason = tp2Hit ? 'TP2' : 'TP1+BE'
    const exitPrice  = tp2Hit ? pos.tp2 : pos.sl
    const gross50r = (exitPrice - pos.entryPrice) * dir * pos.qty * 0.5
    const entryFee = pos.entryPrice * pos.qty * FEE_RATE
    const tp1Fee   = pos.tp1 * pos.qty * 0.5 * FEE_RATE
    const exitFee  = exitPrice * pos.qty * 0.5 * FEE_RATE
    const netPnl   = pos.tp1BookedPnlUsd + gross50r - entryFee - tp1Fee - exitFee
    return buildTrade(pos, exitPrice, exitReason, netPnl, closeTime)
  }

  return null
}

function buildTrade(
  pos: OpenPosition, exitPrice: number, reason: CloseReason, pnlUsd: number, closeTime: number,
): ClosedTrade {
  return {
    symbol: pos.symbol, direction: pos.direction,
    entryPrice: pos.entryPrice, entryTime: pos.entryTime,
    exitPrice, closeReason: reason, pnlUsd, closeTime,
    regime: pos.regime, sizeMultiplier: pos.sizeMultiplier,
    holdingMs: closeTime - pos.entryTime,
  }
}

export function forceClose(pos: OpenPosition, candle: Candle): ClosedTrade {
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

export function loadCandles(symbol: string, interval: string): Candle[] {
  const file = path.join(DATA_DIR, `${symbol}_${interval}.json`)
  if (!fs.existsSync(file)) {
    throw new Error(`Missing: ${file}\nRun "npm run fetch-historical" first.`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Candle[]
}

export interface SymbolData { c1h: Candle[]; c4h: Candle[]; s: SymbolSeries }

export function loadAllData(symbols: readonly Symbol[]): Record<string, SymbolData> {
  const data: Record<string, SymbolData> = {}
  for (const sym of symbols) {
    const c1h = loadCandles(sym, '1h')
    const c4h = loadCandles(sym, '4h')
    data[sym] = { c1h, c4h, s: precompute(c1h, c4h) }
  }
  return data
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface Stats { trades: number; wins: number; totalWinPnl: number; totalLossPnl: number }

export function newStats(): Stats { return { trades: 0, wins: 0, totalWinPnl: 0, totalLossPnl: 0 } }

export function addStats(s: Stats, t: ClosedTrade) {
  s.trades++
  if (t.pnlUsd >= 0) { s.wins++; s.totalWinPnl += t.pnlUsd }
  else s.totalLossPnl += Math.abs(t.pnlUsd)
}

export function winRate(s: Stats)      { return s.trades > 0 ? s.wins / s.trades : 0 }
export function profitFactor(s: Stats) { return s.totalLossPnl > 0 ? s.totalWinPnl / s.totalLossPnl : Infinity }

export function maxDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0], maxDD = 0
  for (const v of equityCurve) {
    if (v > peak) peak = v
    const dd = (peak - v) / peak
    if (dd > maxDD) maxDD = dd
  }
  return maxDD
}

export function maxConsecLosses(trades: ClosedTrade[]): number {
  let max = 0, cur = 0
  for (const t of trades) {
    if (t.pnlUsd < 0) { cur++; if (cur > max) max = cur }
    else cur = 0
  }
  return max
}

// ─── Walk-forward runner ──────────────────────────────────────────────────────

export interface RunOptions {
  symbols: readonly Symbol[]
  strategyConfig: StrategyConfig
  initialCapital: number
  riskPct: number
  /** Only OPEN new positions when candle closeTime falls in [entryWindowStart, entryWindowEnd) */
  entryWindowStart?: number
  entryWindowEnd?: number
}

export interface RunResult {
  allClosed: ClosedTrade[]
  equity: number
  equityCurve: number[]
}

export function runBacktest(data: Record<string, SymbolData>, opts: RunOptions): RunResult {
  const { symbols, strategyConfig: cfg, initialCapital, riskPct } = opts
  const maxLen = Math.max(...symbols.map(sym => data[sym].c1h.length))
  const positions: Record<string, OpenPosition | null> = {}
  for (const sym of symbols) positions[sym] = null

  const allClosed: ClosedTrade[] = []
  let equity = initialCapital
  const equityCurve: number[] = [equity]

  for (let i = 0; i < maxLen; i++) {
    const refSym = symbols.find(sym => i < data[sym].c1h.length)
    if (!refSym) break
    const currentTime = data[refSym].c1h[i].closeTime

    // 1. Check exits
    for (const sym of symbols) {
      const pos = positions[sym]
      if (!pos || i >= data[sym].c1h.length) continue
      const candle = data[sym].c1h[i]
      if (i <= pos.entryCandle) continue

      const closed = checkExitOnCandle(pos, candle)
      if (closed) {
        positions[sym] = null
        allClosed.push(closed)
        equity += closed.pnlUsd
      }
    }

    // 2. Circuit breaker from last 24h
    const dayAgo = currentTime - 24 * 3600 * 1000
    const recent = allClosed.filter(t => t.closeTime > dayAgo)
    const cbState = calcCB(recent, equity, currentTime)

    // 3. Entries — gated to the configured entry window, if any
    const inWindow =
      (opts.entryWindowStart === undefined || currentTime >= opts.entryWindowStart) &&
      (opts.entryWindowEnd   === undefined || currentTime <  opts.entryWindowEnd)

    if (cbState.action !== 'PAUSE_ALL' && inWindow) {
      for (const sym of symbols) {
        if (positions[sym]) continue
        if (i >= data[sym].c1h.length) continue

        const candle = data[sym].c1h[i]
        const j = data[sym].s.align4h[i]
        const sig = detectSignal(sym, data[sym].s, i, j, candle)
        if (!sig) continue

        if (
          cbState.action === 'PAUSE_DIRECTION' &&
          cbState.pausedDirection === sig.direction &&
          cbState.pauseUntil !== undefined &&
          currentTime < cbState.pauseUntil
        ) continue

        positions[sym] = openPosition(sym, candle, i, sig, equity, cbState.sizeMultiplier, cfg, riskPct)
      }
    }

    equityCurve.push(equity)
  }

  for (const sym of symbols) {
    const pos = positions[sym]
    if (!pos) continue
    const lastCandle = data[sym].c1h[data[sym].c1h.length - 1]
    const closed = forceClose(pos, lastCandle)
    allClosed.push(closed)
    equity += closed.pnlUsd
  }
  equityCurve.push(equity)

  return { allClosed, equity, equityCurve }
}
