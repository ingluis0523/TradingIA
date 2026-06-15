import { describe, it, expect } from 'vitest'
import { adxFull } from '../indicators'
import type { Candle } from '@/types/trading'

// ─── Synthetic candle helpers ─────────────────────────────────────────────────

function makeCandle(i: number, open: number, close: number, high: number, low: number): Candle {
  return { openTime: i * 3600000, open, high, low, close, volume: 1000, closeTime: (i + 1) * 3600000 - 1 }
}

/**
 * Choppy market: price oscillates ±1 around 100 with symmetric highs/lows.
 * upMove and downMove cancel each other → DI+ ≈ DI- → DX ≈ 0 → ADX < 20.
 */
function makeChoppyCandles(n: number): Candle[] {
  const candles: Candle[] = []
  let price = 100
  for (let i = 0; i < n; i++) {
    const open = price
    price = i % 2 === 0 ? open + 1 : open - 1
    const high = Math.max(open, price) + 0.5
    const low = Math.min(open, price) - 0.5
    candles.push(makeCandle(i, open, price, high, low))
  }
  return candles
}

/**
 * Strong uptrend: price rises +2 per candle with minimal retracements.
 * upMove >> downMove every candle → DI+ >> DI- → DX ≈ 100 → ADX > 30.
 */
function makeTrendingCandles(n: number): Candle[] {
  const candles: Candle[] = []
  let close = 100
  for (let i = 0; i < n; i++) {
    const open = close
    close = open + 2
    const high = close + 0.3
    const low = open - 0.1
    candles.push(makeCandle(i, open, close, high, low))
  }
  return candles
}

function lastValid(arr: number[]): number {
  return [...arr].reverse().find((v) => !isNaN(v)) ?? NaN
}

// ─── Test 18: ADX corregido distingue regímenes ───────────────────────────────

describe('Test 18 — ADX corregido distingue regímenes', () => {
  const N = 250

  it('mercado choppy sintético → ADX < 20', () => {
    const candles = makeChoppyCandles(N)
    const { adx, diPlus, diMinus } = adxFull(candles)

    const adxFinal = lastValid(adx)
    const diPlusFinal = lastValid(diPlus)
    const diMinusFinal = lastValid(diMinus)

    expect(adxFinal).not.toBeNaN()
    expect(adxFinal).toBeLessThan(20)
    // En mercado choppy DI+ y DI- están equilibrados (ambos bajos o similares)
    expect(Math.abs(diPlusFinal - diMinusFinal)).toBeLessThan(10)
  })

  it('mercado trending fuerte sintético → ADX > 30', () => {
    const candles = makeTrendingCandles(N)
    const { adx, diPlus, diMinus } = adxFull(candles)

    const adxFinal = lastValid(adx)
    const diPlusFinal = lastValid(diPlus)
    const diMinusFinal = lastValid(diMinus)

    expect(adxFinal).not.toBeNaN()
    expect(adxFinal).toBeGreaterThan(30)
    // En uptrend fuerte DI+ debe dominar claramente sobre DI-
    expect(diPlusFinal).toBeGreaterThan(diMinusFinal)
  })

  it('adxFull retorna arrays de la misma longitud que los candles de entrada', () => {
    const candles = makeTrendingCandles(N)
    const { adx, diPlus, diMinus } = adxFull(candles)

    expect(adx).toHaveLength(N)
    expect(diPlus).toHaveLength(N)
    expect(diMinus).toHaveLength(N)
  })

  it('primeros valores son NaN (warmup period)', () => {
    const candles = makeTrendingCandles(N)
    const { adx } = adxFull(candles, 14)

    // ADX necesita 2×period de warmup (DI necesita period, luego ADX otro period)
    expect(adx[0]).toBeNaN()
    expect(adx[13]).toBeNaN()
  })
})
