import { describe, it, expect } from 'vitest'
import {
  calculatePositionSize,
  calculateDailyLoss,
  checkCanOpenPosition,
} from '../risk'
import type { Trade, Signal, AccountInfo, BotConfig } from '@/types/trading'

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    symbol: 'BTCUSDT',
    side: 'BUY',
    status: 'OPEN',
    entryPrice: 50000,
    quantity: 0.1,
    leverage: 3,
    stopLoss: 49000,
    takeProfit1: 52000,
    takeProfit2: 54000,
    tp1Hit: false,
    fee: 5,
    openedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    symbol: 'BTCUSDT',
    type: 'LONG',
    strength: 75,
    price: 3000,
    stopLoss: 2900,
    takeProfit1: 3150,
    takeProfit2: 3300,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    indicators: {} as any,
    reason: 'test',
    timestamp: Date.now(),
    executed: false,
    ...overrides,
  }
}

const baseAccount: AccountInfo = {
  totalBalance: 1000,
  availableBalance: 500,
  totalUnrealizedPnl: 0,
  totalMarginBalance: 1000,
  positions: [],
}

const baseConfig: BotConfig = {
  isRunning: true,
  symbols: ['BTCUSDT', 'BNBUSDT', 'ADAUSDT', 'DOTUSDT'],
  leverage: 3,
  riskPerTrade: 0.02,
  maxPositions: 3,
  maxDailyLoss: 0.05,
  initialCapital: 1000,
  currentCapital: 1000,
  marginType: 'ISOLATED',
  strategy: 'MERINO',
  timeframe: '1h',
}

const noLoss = { realizedLoss: 0, unrealizedLoss: 0, totalLoss: 0 }

// ─── calculatePositionSize ────────────────────────────────────────────────────

describe('calculatePositionSize', () => {
  it('calculates quantity from risk amount and stop distance', () => {
    // riskAmount = 1000 * 0.02 = 20  |  stopDistance = |100 - 95| = 5  →  qty = 4
    const result = calculatePositionSize(1000, 0.02, 100, 95, 3, 3)
    expect(result.quantity).toBe(4)
    expect(result.riskAmount).toBe(20)
    expect(result.positionValue).toBe(400)
    expect(result.margin).toBeCloseTo(133.33, 1)
  })

  it('floors to quantity precision (does not round up)', () => {
    // rawQty = 20 / 3 = 6.666…  → floor at precision 2 → 6.66
    const result = calculatePositionSize(1000, 0.02, 100, 97, 3, 2)
    expect(result.quantity).toBe(6.66)
  })

  it('scales linearly with capital', () => {
    const small = calculatePositionSize(500, 0.02, 100, 95, 3, 3)
    const large = calculatePositionSize(2000, 0.02, 100, 95, 3, 3)
    expect(large.quantity).toBe(small.quantity * 4)
  })

  it('produces smaller qty when stop distance is wider', () => {
    const tight = calculatePositionSize(1000, 0.02, 100, 98, 3, 3)  // dist 2
    const wide  = calculatePositionSize(1000, 0.02, 100, 90, 3, 3)  // dist 10
    expect(tight.quantity).toBeGreaterThan(wide.quantity)
  })
})

// ─── calculateDailyLoss ───────────────────────────────────────────────────────

describe('calculateDailyLoss', () => {
  const now = new Date().toISOString()
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() // 25 h ago

  it('returns zeroes when called with no trades and no positions', () => {
    const snap = calculateDailyLoss([])
    expect(snap.realizedLoss).toBe(0)
    expect(snap.unrealizedLoss).toBe(0)
    expect(snap.totalLoss).toBe(0)
  })

  it('ignores winning closed trades', () => {
    const snap = calculateDailyLoss([makeTrade({ status: 'CLOSED', pnl: 50, closedAt: now })])
    expect(snap.realizedLoss).toBe(0)
  })

  it('counts losing closed trades in the last 24 h', () => {
    const t1 = makeTrade({ id: 't1', status: 'CLOSED', pnl: -30, closedAt: now })
    const t2 = makeTrade({ id: 't2', status: 'CLOSED', pnl: -20, closedAt: now })
    const snap = calculateDailyLoss([t1, t2])
    expect(snap.realizedLoss).toBe(50)
    expect(snap.totalLoss).toBe(50)
  })

  it('ignores losing trades closed more than 24 h ago', () => {
    const snap = calculateDailyLoss([makeTrade({ status: 'CLOSED', pnl: -100, closedAt: old })])
    expect(snap.realizedLoss).toBe(0)
  })

  it('ignores open trades for realized loss even when pnl is negative', () => {
    const snap = calculateDailyLoss([makeTrade({ status: 'OPEN', pnl: -50 })])
    expect(snap.realizedLoss).toBe(0)
  })

  it('includes negative unrealized PnL from open positions', () => {
    const snap = calculateDailyLoss([], [
      { symbol: 'BTCUSDT', unrealizedPnl: -40 },
      { symbol: 'BNBUSDT', unrealizedPnl: -25 },
    ])
    expect(snap.unrealizedLoss).toBe(65)
    expect(snap.totalLoss).toBe(65)
  })

  it('ignores positive unrealized PnL', () => {
    const snap = calculateDailyLoss([], [{ symbol: 'BTCUSDT', unrealizedPnl: 100 }])
    expect(snap.unrealizedLoss).toBe(0)
  })

  it('combines realized and unrealized losses', () => {
    const closed = makeTrade({ status: 'CLOSED', pnl: -30, closedAt: now })
    const snap = calculateDailyLoss([closed], [{ symbol: 'ADAUSDT', unrealizedPnl: -20 }])
    expect(snap.realizedLoss).toBe(30)
    expect(snap.unrealizedLoss).toBe(20)
    expect(snap.totalLoss).toBe(50)
  })
})

// ─── checkCanOpenPosition ─────────────────────────────────────────────────────

describe('checkCanOpenPosition', () => {
  it('blocks when max concurrent positions reached', () => {
    const trades = [
      makeTrade({ id: '1', symbol: 'BTCUSDT' }),
      makeTrade({ id: '2', symbol: 'BNBUSDT' }),
      makeTrade({ id: '3', symbol: 'BNBUSDT' }),
    ]
    const result = checkCanOpenPosition(makeSignal(), trades, baseAccount, baseConfig, noLoss)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/3/)
  })

  it('blocks when symbol already has an open position', () => {
    const trades = [makeTrade({ symbol: 'ADAUSDT', status: 'OPEN' })]
    const result = checkCanOpenPosition(makeSignal({ symbol: 'ADAUSDT' }), trades, baseAccount, baseConfig, noLoss)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/ADAUSDT/)
  })

  it('blocks when daily loss limit is hit (DailyLossSnapshot)', () => {
    // threshold = 0.05 * 1000 = 50; snapshot.totalLoss = 60 → blocked
    const snapshot = { realizedLoss: 60, unrealizedLoss: 0, totalLoss: 60 }
    const result = checkCanOpenPosition(makeSignal(), [], baseAccount, baseConfig, snapshot)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/5/) // "5.0%"
  })

  it('allows when daily loss is below threshold (DailyLossSnapshot)', () => {
    const snapshot = { realizedLoss: 30, unrealizedLoss: 0, totalLoss: 30 }
    const result = checkCanOpenPosition(makeSignal(), [], baseAccount, baseConfig, snapshot)
    expect(result.allowed).toBe(true)
  })

  it('B3 fix: blocks when legacy negative number loss exceeds threshold', () => {
    // Old callers pass a negative sum; was always false before fix
    const result = checkCanOpenPosition(makeSignal(), [], baseAccount, baseConfig, -60)
    expect(result.allowed).toBe(false)
  })

  it('B3 fix: allows when legacy negative number loss is below threshold', () => {
    const result = checkCanOpenPosition(makeSignal(), [], baseAccount, baseConfig, -30)
    expect(result.allowed).toBe(true)
  })

  it('blocks when available balance is insufficient', () => {
    const poorAccount = { ...baseAccount, availableBalance: 0.01 }
    const result = checkCanOpenPosition(makeSignal(), [], poorAccount, baseConfig, noLoss)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/Balance/)
  })

  it('blocks when signal strength is below 60', () => {
    const result = checkCanOpenPosition(makeSignal({ strength: 55 }), [], baseAccount, baseConfig, noLoss)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/60/)
  })

  it('allows when signal strength is exactly 60', () => {
    const result = checkCanOpenPosition(makeSignal({ strength: 60 }), [], baseAccount, baseConfig, noLoss)
    expect(result.allowed).toBe(true)
  })

  it('allows when all conditions pass', () => {
    const result = checkCanOpenPosition(makeSignal(), [], baseAccount, baseConfig, noLoss)
    expect(result.allowed).toBe(true)
    expect(result.reason).toBeUndefined()
  })
})
