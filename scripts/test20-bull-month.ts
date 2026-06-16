/**
 * Test 20 — El bot genera LONGs en bull market.
 *
 * Spec (01b, sección 9): "Backtest sobre un mes alcista conocido → debe haber
 * LONGs y deben ser mayoría."
 *
 * The dataset's most bullish month overall is 2025-12-17 → 2026-01-16
 * (BTC +10.8%), but that's the very start of the dataset — the regime filter
 * needs ~250 4h candles (~42 days) of warmup before it can classify anything,
 * so no signal could fire there regardless of trend. Scanning all 5 symbols
 * (not just BTC) for a month where every symbol is positive, with warmup
 * available, finds 2026-04-01 → 2026-05-01: BTC +14.7%, ETH +7.2%, BNB +0.7%,
 * XRP +2.7%, SOL +3.2% — a clean broad-market bull month.
 * Walk-forward still uses the full dataset for indicator warmup; only ENTRIES
 * are gated to this window so trades aren't biased by an undersized lookback.
 *
 * Usage: npm run test20
 */

import { SYMBOLS, NEW_STRATEGY, loadAllData, runBacktest, type Direction } from './lib/engine'

const INITIAL_CAPITAL = 10_000
const RISK_PCT = 0.01

const WINDOW_START = new Date('2026-04-01T00:00:00Z').getTime()
const WINDOW_END   = new Date('2026-05-01T00:00:00Z').getTime()

async function main() {
  console.log('\n══════════════════════════════════════════════════════════')
  console.log('  TEST 20 — LONGs en mes alcista conocido')
  console.log(`  Ventana: ${new Date(WINDOW_START).toISOString().slice(0, 10)} → ${new Date(WINDOW_END).toISOString().slice(0, 10)}`)
  console.log('══════════════════════════════════════════════════════════\n')

  const data = loadAllData(SYMBOLS)

  const { allClosed } = runBacktest(data, {
    symbols: SYMBOLS,
    strategyConfig: NEW_STRATEGY,
    initialCapital: INITIAL_CAPITAL,
    riskPct: RISK_PCT,
    entryWindowStart: WINDOW_START,
    entryWindowEnd: WINDOW_END,
  })

  // Only count trades ENTERED within the bull window (exits may land slightly after)
  const windowTrades = allClosed.filter(t => t.entryTime >= WINDOW_START && t.entryTime < WINDOW_END)

  const counts: Record<Direction, number> = { LONG: 0, SHORT: 0 }
  for (const t of windowTrades) counts[t.direction]++

  console.log(`  Trades en ventana: ${windowTrades.length}`)
  console.log(`  LONG:  ${counts.LONG}`)
  console.log(`  SHORT: ${counts.SHORT}`)

  const longMajority = windowTrades.length > 0 && counts.LONG > counts.SHORT
  const hasLongs = counts.LONG > 0

  console.log('\n── Resultado ────────────────────────────────────────────────')
  console.log(`  [${hasLongs ? '✓' : '✗'}] Se generaron LONGs: ${counts.LONG} trades`)
  console.log(`  [${longMajority ? '✓' : '✗'}] LONGs son mayoría: ${counts.LONG} > ${counts.SHORT}`)

  const passed = hasLongs && longMajority
  console.log(`\n  ${passed ? '✅ TEST 20 PASSED' : '❌ TEST 20 FAILED'}`)
  console.log()

  process.exit(passed ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
