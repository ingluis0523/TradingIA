/**
 * backtest.ts — Walk-forward backtest for Phase 1.5 strategy (full 6-month report).
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

import {
  SYMBOLS, NEW_STRATEGY, loadAllData, runBacktest,
  newStats, addStats, winRate, profitFactor, maxDrawdown, maxConsecLosses,
  type Direction, type Stats,
} from './lib/engine'

const INITIAL_CAPITAL = 10_000
const RISK_PCT = 0.01

async function main() {
  console.log('\n══════════════════════════════════════════════════════════')
  console.log('  BACKTEST — Phase 1.5 Strategy (regime + ADX fix + CB)')
  console.log('══════════════════════════════════════════════════════════\n')

  let data
  try {
    console.log('  Loading data...')
    data = loadAllData(SYMBOLS)
    for (const sym of SYMBOLS) {
      console.log(`  ${sym}: ${data[sym].c1h.length} × 1h, ${data[sym].c4h.length} × 4h`)
    }
  } catch (e) {
    console.error(`\n  ERROR: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }

  const { allClosed, equity, equityCurve } = runBacktest(data, {
    symbols: SYMBOLS,
    strategyConfig: NEW_STRATEGY,
    initialCapital: INITIAL_CAPITAL,
    riskPct: RISK_PCT,
  })

  // ── Aggregate stats ───────────────────────────────────────────────────────
  const symStats: Record<string, Stats> = {}
  const dirStats: Record<Direction, Stats> = { LONG: newStats(), SHORT: newStats() }
  const regStats: Record<string, Stats> = {}
  for (const sym of SYMBOLS) symStats[sym] = newStats()

  for (const t of allClosed) {
    addStats(symStats[t.symbol], t)
    addStats(dirStats[t.direction], t)
    if (!regStats[t.regime]) regStats[t.regime] = newStats()
    addStats(regStats[t.regime], t)
  }

  const total = newStats()
  for (const sym of SYMBOLS) {
    total.trades += symStats[sym].trades
    total.wins += symStats[sym].wins
    total.totalWinPnl += symStats[sym].totalWinPnl
    total.totalLossPnl += symStats[sym].totalLossPnl
  }

  const dd = maxDrawdown(equityCurve)
  const mcl = maxConsecLosses(allClosed)
  const pnlUsd = equity - INITIAL_CAPITAL
  const pnlPct = pnlUsd / INITIAL_CAPITAL * 100

  const fmt = (n: number, dec = 1) => n.toFixed(dec)
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`

  console.log('\n── Per-symbol ──────────────────────────────────────────────')
  for (const sym of SYMBOLS) {
    const s = symStats[sym]
    if (s.trades === 0) { console.log(`  ${sym}: 0 trades`); continue }
    console.log(`  ${sym}: ${s.trades} trades | WR ${pct(winRate(s))} | PF ${fmt(profitFactor(s), 2)}`)
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
  const rangCount = regStats['RANGING']?.trades ?? 0
  if (transCount === 0) console.log('  TRANSITION: 0 trades ✓ (filter working)')
  if (rangCount === 0) console.log('  RANGING:    0 trades ✓ (filter working)')

  console.log('\n── Equity curve ────────────────────────────────────────────')
  console.log(miniChart(equityCurve))
  console.log(`  Start: $${INITIAL_CAPITAL}  →  End: $${fmt(equity, 0)}`)

  console.log('\n── Spec 8.3 validation ─────────────────────────────────────')
  const longPct = total.trades > 0 ? dirStats.LONG.trades / total.trades : 0
  const wr = winRate(total)
  const pf = profitFactor(total)

  const check = (ok: boolean, msg: string) => console.log(`  [${ok ? '✓' : '✗'}] ${msg}`)
  check(dirStats.LONG.trades > 0, `LONGs generated: ${dirStats.LONG.trades} trades`)
  check(wr >= 0.42, `Win rate: ${pct(wr)} (target ≥ 42%)`)
  check(pf >= 1.25, `Profit factor: ${fmt(pf, 2)} (target ≥ 1.25)`)
  check(transCount === 0, `TRANSITION trades: ${transCount} (target = 0)`)
  check(dd <= 0.15, `Max drawdown: ${pct(dd)} (target ≤ 15%)`)
  check(longPct >= 0.2 && longPct <= 0.8, `LONG/SHORT balance: ${pct(longPct)} LONG (target 20-80%)`)

  const allPass = dirStats.LONG.trades > 0 && wr >= 0.42 && pf >= 1.25 &&
                  transCount === 0 && dd <= 0.15 && longPct >= 0.2 && longPct <= 0.8
  console.log(`\n  ${allPass ? '✅ ALL CRITERIA PASSED — ready for shadow re-validation' : '❌ Some criteria failed — iterate parameters before redeploy'}`)
  console.log()
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

main().catch(err => { console.error(err); process.exit(1) })
