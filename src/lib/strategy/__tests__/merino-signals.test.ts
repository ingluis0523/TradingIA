/**
 * Tests M2-M6 — Merino strategy signal generation
 *
 * M2: valid bullish scenario → LONG
 * M3: price below EMA200 daily → null (macro filter)
 * M4: bearish scenario → always null (no shorts)
 * M5: symbol outside universe → null immediately
 * M6: tp1Hit + momentum flip → shouldCloseOnMomentumFlip returns true
 *
 * M2-M5 mock the indicators module so we control the indicator values
 * and test only the decision logic. M1 (squeeze.test.ts) covers indicator correctness.
 * M6 tests the momentum-flip close function with real candles.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  addLogForUser: vi.fn().mockResolvedValue(undefined),
  supabase: {},
  supabaseAdmin: {},
  SYSTEM_USER_ID: '00000000-0000-0000-0000-000000000001',
}))

// Mock indicators so we can inject controlled values
vi.mock('../indicators', () => ({
  ema: vi.fn(),
  atr: vi.fn(),
  adx: vi.fn(),
  squeezeMomentum: vi.fn(),
  aggregate4hToDaily: vi.fn(),
  calculateIndicators: vi.fn(),
  calculateIndicatorsPrev: vi.fn(),
}))

import { generateSignal, shouldCloseOnMomentumFlip } from '../signals'
import * as indicators from '../indicators'
import type { Candle, TradingSymbol } from '@/types/trading'

const MS_4H = 4 * 3600 * 1000

function makeCandles(n: number, close = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * MS_4H,
    open: close, close, high: close + 1, low: close - 1,
    volume: 1_000_000,
    closeTime: (i + 1) * MS_4H - 1,
  }))
}

function makeArray(n: number, val: number, lastVal?: number): number[] {
  const arr = new Array(n).fill(val)
  if (lastVal !== undefined) arr[arr.length - 1] = lastVal
  return arr
}

/**
 * Set up mocks so all 5 Merino conditions are satisfied.
 *
 * Conditions:
 * 1. EMA10 > EMA55     → emaFast[last] > emaSlow[last]
 * 2. sqzOff[last]=true AND recent sqzOn → sqzOff array, sqzOn array
 * 3. sqzVal[last] > 0 AND > sqzVal[last-1]
 * 4. adx[last] > 20 AND > adx[last-3]
 * 5. currentPrice > EMA200 daily
 */
function setupBullishMocks(n = 400) {
  const emaFastArr  = makeArray(n, 110)                      // fast EMA = 110
  const emaSlowArr  = makeArray(n, 100)                      // slow EMA = 100 → fast > slow ✓
  const sqzValArr   = [...makeArray(n - 1, 1.0), 1.5]       // rising: prev=1.0 last=1.5 ✓
  const sqzOnArr    = new Array(n).fill(false)
  sqzOnArr[n - 3]   = true                                   // squeeze was on 3 bars ago ✓
  sqzOnArr[n - 2]   = true
  const sqzOffArr   = [...new Array(n - 1).fill(false), true]  // sqzOff only at last bar ✓
  const adxArr      = makeArray(n, 22)                       // ADX > 20 ✓
  adxArr[n - 4]     = 18                                     // last-3 was 18 → ADX rising ✓
  const atrArr      = makeArray(n, 5)                        // ATR = 5
  const dailyCandles = makeCandles(250, 80)                  // EMA200 daily baseline = 80
  const emaMacroArr = makeArray(250, 80)                     // EMA200 daily = 80

  vi.mocked(indicators.ema).mockImplementation((_values, period) => {
    if (period === 10)  return emaFastArr
    if (period === 55)  return emaSlowArr
    if (period === 200) return emaMacroArr
    return makeArray(_values.length, 100)
  })
  vi.mocked(indicators.squeezeMomentum).mockReturnValue({
    val: sqzValArr, sqzOn: sqzOnArr, sqzOff: sqzOffArr,
  })
  vi.mocked(indicators.adx).mockReturnValue(adxArr)
  vi.mocked(indicators.atr).mockReturnValue(atrArr)
  vi.mocked(indicators.aggregate4hToDaily).mockReturnValue(dailyCandles)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── M2: bullish scenario → LONG ─────────────────────────────────────────────

describe('Test M2 — escenario alcista válido → señal LONG', () => {
  it('genera señal LONG cuando se cumplen las 5 condiciones Merino', async () => {
    const n = 400
    setupBullishMocks(n)
    const candles4h = makeCandles(n, 150)
    const currentPrice = 150 // > EMA200 daily (80) ✓

    const signal = await generateSignal({ symbol: 'BTCUSDT', candles4h, currentPrice })

    expect(signal).not.toBeNull()
    expect(signal?.type).toBe('LONG')
    expect(signal?.symbol).toBe('BTCUSDT')
    expect(signal?.stopLoss).toBeLessThan(currentPrice)
    expect(signal?.takeProfit1).toBeGreaterThan(currentPrice)
    expect(signal?.takeProfit2).toBeGreaterThan(signal?.takeProfit1 ?? 0)
    expect(signal?.reason).toContain('MERINO LONG')
    expect(signal?.strength).toBeGreaterThanOrEqual(0)
    expect(signal?.strength).toBeLessThanOrEqual(100)
  })

  it('SL = entry - ATR*2.5 por defecto', async () => {
    const n = 400
    setupBullishMocks(n)
    const candles4h = makeCandles(n, 150)

    const signal = await generateSignal({ symbol: 'BTCUSDT', candles4h, currentPrice: 150 })

    expect(signal?.stopLoss).toBeCloseTo(150 - 5 * 2.5, 6)   // ATR=5, SL_ATR_MULT=2.5
    expect(signal?.takeProfit1).toBeCloseTo(150 + 5 * 3.0, 6) // TP1_ATR_MULT=3.0
    expect(signal?.takeProfit2).toBeCloseTo(150 + 5 * 6.0, 6) // TP2_ATR_MULT=6.0
  })

  it('acepta slAtrMult/tp1AtrMult/tp2AtrMult personalizados', async () => {
    const n = 400
    setupBullishMocks(n)
    const candles4h = makeCandles(n, 100)

    const signal = await generateSignal({
      symbol: 'BTCUSDT', candles4h, currentPrice: 100,
      slAtrMult: 1.0, tp1AtrMult: 2.0, tp2AtrMult: 4.0,
    })

    expect(signal?.stopLoss).toBeCloseTo(100 - 5 * 1.0, 6)
    expect(signal?.takeProfit1).toBeCloseTo(100 + 5 * 2.0, 6)
    expect(signal?.takeProfit2).toBeCloseTo(100 + 5 * 4.0, 6)
  })
})

// ─── M3: macro filter blocks when price < EMA200 daily ───────────────────────

describe('Test M3 — precio bajo EMA200 diaria → null (filtro macro)', () => {
  it('retorna null cuando currentPrice < EMA200 diaria', async () => {
    const n = 400
    setupBullishMocks(n)
    // EMA200 daily returns 80, but currentPrice = 50 < 80
    const signal = await generateSignal({
      symbol: 'BTCUSDT', candles4h: makeCandles(n, 50), currentPrice: 50,
    })
    expect(signal).toBeNull()
  })

  it('retorna LONG cuando currentPrice está justo sobre EMA200 diaria', async () => {
    const n = 400
    setupBullishMocks(n)
    // EMA200 daily = 80; currentPrice = 80.01 → just above
    const signal = await generateSignal({
      symbol: 'BTCUSDT', candles4h: makeCandles(n, 80), currentPrice: 80.01,
    })
    expect(signal).not.toBeNull()
    expect(signal?.type).toBe('LONG')
  })
})

// ─── M4: never generates SHORT ────────────────────────────────────────────────

describe('Test M4 — nunca genera shorts (long-only)', () => {
  it('retorna null cuando EMA10 < EMA55 (no sesgo alcista)', async () => {
    const n = 400
    setupBullishMocks(n)
    // Override ema so fast < slow
    vi.mocked(indicators.ema).mockImplementation((_values, period) => {
      if (period === 10)  return makeArray(n, 90)   // EMA10 = 90 < EMA55 = 100
      if (period === 55)  return makeArray(n, 100)
      if (period === 200) return makeArray(250, 80)
      return makeArray(_values.length, 100)
    })
    const signal = await generateSignal({
      symbol: 'BTCUSDT', candles4h: makeCandles(n, 150), currentPrice: 150,
    })
    expect(signal).toBeNull()
  })

  it('retorna null cuando no hay squeeze release (sqzOff=false)', async () => {
    const n = 400
    setupBullishMocks(n)
    // Override sqzOff to always false
    vi.mocked(indicators.squeezeMomentum).mockReturnValue({
      val: makeArray(n, 1.5),
      sqzOn: new Array(n).fill(false),
      sqzOff: new Array(n).fill(false), // no release
    })
    const signal = await generateSignal({
      symbol: 'BTCUSDT', candles4h: makeCandles(n, 150), currentPrice: 150,
    })
    expect(signal).toBeNull()
  })

  it('retorna null cuando momentum es negativo', async () => {
    const n = 400
    setupBullishMocks(n)
    const sqzValArr = makeArray(n, -1.0)  // negative momentum
    const sqzOnArr  = new Array(n).fill(false)
    sqzOnArr[n - 2] = true
    const sqzOffArr = [...new Array(n - 1).fill(false), true]
    vi.mocked(indicators.squeezeMomentum).mockReturnValue({
      val: sqzValArr, sqzOn: sqzOnArr, sqzOff: sqzOffArr,
    })
    const signal = await generateSignal({
      symbol: 'BTCUSDT', candles4h: makeCandles(n, 150), currentPrice: 150,
    })
    expect(signal).toBeNull()
  })

  it('retorna null cuando ADX < 20', async () => {
    const n = 400
    setupBullishMocks(n)
    vi.mocked(indicators.adx).mockReturnValue(makeArray(n, 15)) // weak ADX
    const signal = await generateSignal({
      symbol: 'BTCUSDT', candles4h: makeCandles(n, 150), currentPrice: 150,
    })
    expect(signal).toBeNull()
  })

  it('el signal nunca tiene type SHORT', async () => {
    // Run with multiple symbols — none should ever produce SHORT
    const symbols: TradingSymbol[] = ['BTCUSDT', 'BNBUSDT', 'ADAUSDT', 'DOTUSDT']
    for (const symbol of symbols) {
      const n = 400
      setupBullishMocks(n)
      const signal = await generateSignal({ symbol, candles4h: makeCandles(n, 150), currentPrice: 150 })
      if (signal !== null) {
        expect(signal.type).not.toBe('SHORT')
      }
    }
  })
})

// ─── M5: symbols outside universe → null immediately ─────────────────────────

describe('Test M5 — símbolos fuera del universo → null inmediato', () => {
  // No mocks needed — symbol check is first thing in generateSignal

  it('ETHUSDT retorna null', async () => {
    const signal = await generateSignal({
      symbol: 'ETHUSDT' as TradingSymbol,
      candles4h: makeCandles(400, 2000),
      currentPrice: 2000,
    })
    expect(signal).toBeNull()
  })

  it('XRPUSDT retorna null', async () => {
    const signal = await generateSignal({
      symbol: 'XRPUSDT' as TradingSymbol,
      candles4h: makeCandles(400, 0.5),
      currentPrice: 0.5,
    })
    expect(signal).toBeNull()
  })

  it('string vacío retorna null', async () => {
    const signal = await generateSignal({
      symbol: '' as TradingSymbol,
      candles4h: makeCandles(400, 100),
      currentPrice: 100,
    })
    expect(signal).toBeNull()
  })

  it('retorna null con < 300 velas (insuficientes)', async () => {
    const signal = await generateSignal({
      symbol: 'BTCUSDT',
      candles4h: makeCandles(299, 100),
      currentPrice: 100,
    })
    expect(signal).toBeNull()
  })
})

// ─── M6: momentum flip → shouldCloseOnMomentumFlip ───────────────────────────

describe('Test M6 — salida por momentum flip', () => {
  // shouldCloseOnMomentumFlip uses squeezeMomentum directly (not mocked here)
  // We restore the real implementation for this test suite
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('retorna false cuando tp1Hit=false (aunque momentum sea negativo)', () => {
    const candles = makeCandles(80, 100)
    expect(shouldCloseOnMomentumFlip(candles, false)).toBe(false)
  })

  it('retorna false cuando hay < 30 velas', () => {
    const short = makeCandles(20, 100)
    expect(shouldCloseOnMomentumFlip(short, true)).toBe(false)
  })

  it('retorna true cuando tp1Hit=true y val[last]<0 y val[last]<val[last-1]', () => {
    // Override squeezeMomentum to return controlled negative + falling momentum
    vi.spyOn(indicators, 'squeezeMomentum').mockReturnValueOnce({
      val:    [...new Array(79).fill(0.5), -0.5],  // last val < 0 and falling from 0.5
      sqzOn:  new Array(80).fill(false),
      sqzOff: new Array(80).fill(true),
    })
    const candles = makeCandles(80, 100)
    expect(shouldCloseOnMomentumFlip(candles, true)).toBe(true)
  })

  it('retorna false cuando tp1Hit=true pero val[last]>=0', () => {
    vi.spyOn(indicators, 'squeezeMomentum').mockReturnValueOnce({
      val:    new Array(80).fill(1.0),  // positive momentum
      sqzOn:  new Array(80).fill(false),
      sqzOff: new Array(80).fill(true),
    })
    const candles = makeCandles(80, 100)
    expect(shouldCloseOnMomentumFlip(candles, true)).toBe(false)
  })

  it('retorna false cuando tp1Hit=true, val[last]<0 pero NO cayendo (val[last]>=val[last-1])', () => {
    vi.spyOn(indicators, 'squeezeMomentum').mockReturnValueOnce({
      val:    [...new Array(79).fill(-1.0), -0.5],  // val[last]=-0.5 > val[last-1]=-1.0 → not falling
      sqzOn:  new Array(80).fill(false),
      sqzOff: new Array(80).fill(true),
    })
    const candles = makeCandles(80, 100)
    expect(shouldCloseOnMomentumFlip(candles, true)).toBe(false)
  })
})
