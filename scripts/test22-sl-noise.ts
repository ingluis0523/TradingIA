/**
 * Test 22 — SL no salta por ruido.
 *
 * Spec (01b, sección 9): "Backtest: comparar % de trades cerrados por SL en
 * <30 min entre versión vieja (1.5 ATR) y nueva (2.2 ATR). Debe bajar."
 *
 * Candle granularity is 1h, so "<30 min" can't be measured directly. The
 * faithful proxy: trades whose FIRST touch (SL or break-even) happens within
 * one candle of entry (holdingMs <= 3_600_000) — i.e. stopped out almost
 * immediately, the signature of a stop too tight for 1h noise. Only the
 * ATR multiplier changes between runs (OLD_STRATEGY vs NEW_STRATEGY);
 * regime/ADX logic stays identical so the comparison isolates that one variable.
 *
 * Usage: npm run test22
 */

import {
  SYMBOLS, NEW_STRATEGY, OLD_STRATEGY, loadAllData, runBacktest, type ClosedTrade,
} from './lib/engine'

const INITIAL_CAPITAL = 10_000
const RISK_PCT = 0.01
const QUICK_STOP_MS = 3_600_000  // 1 candle — closest measurable proxy for "<30 min"

function quickStopPct(trades: ClosedTrade[]): { pct: number; quickStops: number; slTrades: number } {
  const slTrades = trades.filter(t => t.closeReason === 'SL')
  const quickStops = slTrades.filter(t => t.holdingMs <= QUICK_STOP_MS)
  return {
    pct: slTrades.length > 0 ? quickStops.length / slTrades.length : 0,
    quickStops: quickStops.length,
    slTrades: slTrades.length,
  }
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════')
  console.log('  TEST 22 — SL no salta por ruido (vieja 1.5 ATR vs nueva 2.2 ATR)')
  console.log('══════════════════════════════════════════════════════════\n')

  const data = loadAllData(SYMBOLS)

  console.log('  Corriendo versión VIEJA (SL 1.5 ATR, TP1 2.5, TP2 4.0)...')
  const oldRun = runBacktest(data, {
    symbols: SYMBOLS, strategyConfig: OLD_STRATEGY,
    initialCapital: INITIAL_CAPITAL, riskPct: RISK_PCT,
  })

  console.log('  Corriendo versión NUEVA (SL 2.2 ATR, TP1 2.0, TP2 3.5)...')
  const newRun = runBacktest(data, {
    symbols: SYMBOLS, strategyConfig: NEW_STRATEGY,
    initialCapital: INITIAL_CAPITAL, riskPct: RISK_PCT,
  })

  const oldStats = quickStopPct(oldRun.allClosed)
  const newStats = quickStopPct(newRun.allClosed)

  const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`

  console.log('\n── Resultado ────────────────────────────────────────────────')
  console.log(`  VIEJA: ${oldStats.slTrades} trades cerrados por SL, ${oldStats.quickStops} en ≤1 vela (${fmtPct(oldStats.pct)})`)
  console.log(`  NUEVA: ${newStats.slTrades} trades cerrados por SL, ${newStats.quickStops} en ≤1 vela (${fmtPct(newStats.pct)})`)

  const improved = newStats.pct < oldStats.pct
  console.log(`\n  [${improved ? '✓' : '✗'}] % de stops rápidos bajó: ${fmtPct(oldStats.pct)} → ${fmtPct(newStats.pct)}`)

  console.log(`\n  ${improved ? '✅ TEST 22 PASSED' : '❌ TEST 22 FAILED'}`)
  console.log()

  process.exit(improved ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
