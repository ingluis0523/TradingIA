import { describe, it, expect } from 'vitest'
import { evaluateCircuitBreaker } from '../risk'
import type { Trade } from '@/types/trading'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTrade(
  side: 'BUY' | 'SELL',
  pnl: number,
  minutesAgo: number,
): Trade {
  const closedAt = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString()
  const openedAt = new Date(Date.now() - (minutesAgo + 60) * 60 * 1000).toISOString()
  return {
    id: `test-${Math.random()}`,
    symbol: 'BTCUSDT',
    side,
    status: 'CLOSED',
    entryPrice: 50000,
    quantity: 0.001,
    leverage: 3,
    stopLoss: 49000,
    takeProfit1: 51000,
    takeProfit2: 52000,
    tp1Hit: false,
    fee: 0.05,
    pnl,
    openedAt,
    closedAt,
  }
}

const MAX_DAILY_LOSS = 0.05  // 5%
const CAPITAL = 1000         // $1 000 allocated

// ─── Test 21: Circuit breaker escalado ───────────────────────────────────────

describe('Test 21 — Circuit breaker escalado (3 escalones)', () => {

  // ── NONE ────────────────────────────────────────────────────────────────────

  it('sin trades → NONE, sizeMultiplier 1.0', () => {
    const cb = evaluateCircuitBreaker([], MAX_DAILY_LOSS, CAPITAL)
    expect(cb.action).toBe('NONE')
    expect(cb.sizeMultiplier).toBe(1.0)
    expect(cb.consecutiveLosses).toBe(0)
  })

  it('trades con ganancia → NONE, sizeMultiplier 1.0', () => {
    const trades = [
      makeTrade('BUY',  15, 30),
      makeTrade('SELL', 10, 90),
    ]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    expect(cb.action).toBe('NONE')
    expect(cb.sizeMultiplier).toBe(1.0)
    expect(cb.consecutiveLosses).toBe(0)
  })

  it('1 sola pérdida → NONE (no llega a ningún escalón)', () => {
    const trades = [makeTrade('BUY', -8, 20)]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    expect(cb.action).toBe('NONE')
    expect(cb.consecutiveLosses).toBe(1)
  })

  // ── Tier 1: REDUCE_SIZE ──────────────────────────────────────────────────────

  it('Tier 1 — 2 pérdidas seguidas → REDUCE_SIZE, sizeMultiplier 0.5', () => {
    const trades = [
      makeTrade('BUY',  -10, 10),   // most recent — loss
      makeTrade('SELL', -8,  30),   // 2nd — loss
      makeTrade('BUY',   15, 90),   // 3rd — win (stops the streak)
    ]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    expect(cb.action).toBe('REDUCE_SIZE')
    expect(cb.sizeMultiplier).toBe(0.5)
    expect(cb.consecutiveLosses).toBe(2)
  })

  it('Tier 1 — pérdida interrumpida por ganancia no activa REDUCE_SIZE', () => {
    const trades = [
      makeTrade('BUY', -10, 10),  // most recent — loss (only 1 consecutive)
      makeTrade('BUY',  12, 30),  // win — breaks streak
      makeTrade('BUY', -8,  60),  // old loss, irrelevant for streak
    ]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    expect(cb.action).toBe('NONE')
    expect(cb.consecutiveLosses).toBe(1)
  })

  // ── Tier 2: PAUSE_DIRECTION ──────────────────────────────────────────────────

  it('Tier 2 — 3 pérdidas seguidas en LONG → PAUSE_DIRECTION=LONG', () => {
    const trades = [
      makeTrade('BUY', -10, 5),    // most recent — LONG loss
      makeTrade('BUY', -8,  20),   // LONG loss
      makeTrade('BUY', -12, 40),   // LONG loss  ← 3rd (index 2)
      makeTrade('SELL', 20, 90),   // win before
    ]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    expect(cb.action).toBe('PAUSE_DIRECTION')
    expect(cb.pausedDirection).toBe('LONG')
    expect(cb.sizeMultiplier).toBe(0.5)
    expect(cb.pauseUntil).toBeDefined()
    // pauseUntil = closedAt_of_3rd_loss + 6h — the 3rd loss was 40 min ago,
    // so we expect pauseUntil to be between now+5h and now+6h
    const now = Date.now()
    expect(cb.pauseUntil!.getTime()).toBeGreaterThan(now + 5 * 3600 * 1000)
    expect(cb.pauseUntil!.getTime()).toBeLessThan(now + 6 * 3600 * 1000)
  })

  it('Tier 2 — 3 pérdidas seguidas en SHORT → PAUSE_DIRECTION=SHORT', () => {
    const trades = [
      makeTrade('SELL', -10, 5),
      makeTrade('SELL', -8,  20),
      makeTrade('SELL', -12, 40),
      makeTrade('BUY',   20, 90),
    ]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    expect(cb.action).toBe('PAUSE_DIRECTION')
    expect(cb.pausedDirection).toBe('SHORT')
  })

  it('Tier 2 — 3 pérdidas en direcciones mezcladas → solo REDUCE_SIZE, no PAUSE_DIRECTION', () => {
    // Consecutive losses but not all in the same direction
    const trades = [
      makeTrade('BUY',  -10, 5),    // LONG
      makeTrade('SELL', -8,  20),   // SHORT — different
      makeTrade('BUY',  -12, 40),   // LONG
    ]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    // 3 consecutive losses but mixed direction → can't pause a specific direction
    expect(cb.action).toBe('REDUCE_SIZE')
    expect(cb.consecutiveLosses).toBe(3)
    expect(cb.pausedDirection).toBeUndefined()
  })

  // ── Tier 3: PAUSE_ALL ────────────────────────────────────────────────────────

  it('Tier 3 — daily loss >= maxDailyLoss → PAUSE_ALL, sizeMultiplier 0', () => {
    // $30 + $35 = $65 loss on $1000 capital = 6.5% > 5% limit
    const trades = [
      makeTrade('BUY',  -30, 10),
      makeTrade('SELL', -35, 30),
    ]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    expect(cb.action).toBe('PAUSE_ALL')
    expect(cb.sizeMultiplier).toBe(0)
    expect(cb.dailyLossPct).toBeGreaterThanOrEqual(MAX_DAILY_LOSS)
    expect(cb.pauseUntil).toBeDefined()
    // pauseUntil should be tomorrow UTC midnight
    const tomorrow = new Date()
    tomorrow.setUTCHours(24, 0, 0, 0)
    expect(Math.abs(cb.pauseUntil!.getTime() - tomorrow.getTime())).toBeLessThan(5000)
  })

  it('Tier 3 tiene prioridad sobre Tier 2 (PAUSE_ALL > PAUSE_DIRECTION)', () => {
    // 3 same-dir losses AND exceeded daily limit → PAUSE_ALL wins
    const trades = [
      makeTrade('BUY', -20, 5),
      makeTrade('BUY', -20, 20),
      makeTrade('BUY', -20, 40),  // $60 total = 6% > 5%
    ]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    expect(cb.action).toBe('PAUSE_ALL')
  })

  it('Tier 3 tiene prioridad sobre Tier 1 (PAUSE_ALL > REDUCE_SIZE)', () => {
    const trades = [
      makeTrade('BUY', -25, 10),  // 2 consecutive losses
      makeTrade('SELL', -30, 30), // + $55 total = 5.5% > 5%
    ]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    expect(cb.action).toBe('PAUSE_ALL')
  })

  // ── dailyLossPct calculation ─────────────────────────────────────────────────

  it('dailyLossPct solo suma pérdidas, ignora ganancias', () => {
    const trades = [
      makeTrade('BUY',  -10, 10),   // loss: $10
      makeTrade('SELL',  25, 30),   // win: ignored
      makeTrade('BUY',  -15, 60),   // loss: $15  → total $25 = 2.5%
    ]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, CAPITAL)
    expect(cb.dailyLossPct).toBeCloseTo(0.025, 5)
    // 2.5% < 5% → no PAUSE_ALL
    expect(cb.action).not.toBe('PAUSE_ALL')
  })

  it('allocatedCapital 0 → dailyLossPct 0, no PAUSE_ALL', () => {
    const trades = [makeTrade('BUY', -100, 10)]
    const cb = evaluateCircuitBreaker(trades, MAX_DAILY_LOSS, 0)
    expect(cb.dailyLossPct).toBe(0)
    expect(cb.action).not.toBe('PAUSE_ALL')
  })
})
