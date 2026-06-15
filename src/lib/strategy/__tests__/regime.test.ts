import { describe, it, expect } from 'vitest'
import { analyzeRegime } from '../regime'
import type { Candle } from '@/types/trading'

// ─── Synthetic candle builder ─────────────────────────────────────────────────

function makeCandle(i: number, open: number, close: number, high: number, low: number): Candle {
  return { openTime: i * 3600000, open, high, low, close, volume: 1000, closeTime: (i + 1) * 3600000 - 1 }
}

/**
 * Builds synthetic 4h candles that replicate the June 2026 scenario:
 *   60 candles  — warmup (flat at 100)
 *  168 candles  — sustained downtrend: −26% total
 *    N candles  — bounce: +30% total
 *
 * The downtrend is consistent (downMove > upMove every bar) so DI- accumulates
 * and ADX rises. The bounce reverses that with consistent upMoves.
 */
function buildJuneScenario(bounceLen: number): Candle[] {
  const candles: Candle[] = []
  let idx = 0
  let close = 100

  // Warmup: flat (provides EMA/ADX warmup without biasing direction)
  for (let i = 0; i < 60; i++) {
    const open = close
    candles.push(makeCandle(idx++, open, close, close + 0.05, close - 0.05))
  }

  // Downtrend: 100 → 74 (−26%) over 168 candles, each candle slightly lower
  const downFactor = Math.pow(0.74, 1 / 168)
  for (let i = 0; i < 168; i++) {
    const open = close
    close = open * downFactor
    const range = open - close            // positive
    const high  = open  + range * 0.05   // tiny upper wick
    const low   = close - range * 0.05   // tiny lower wick
    candles.push(makeCandle(idx++, open, close, high, low))
  }

  // Bounce: up +30% over bounceLen candles
  if (bounceLen > 0) {
    const upFactor = Math.pow(1.30, 1 / bounceLen)
    for (let i = 0; i < bounceLen; i++) {
      const open = close
      close = open * upFactor
      const range = close - open
      const high  = close + range * 0.05
      const low   = open  - range * 0.05
      candles.push(makeCandle(idx++, open, close, high, low))
    }
  }

  return candles
}

// ─── Test 19: Régimen bloquea TRANSITION durante rebote tras caída ─────────────

describe('Test 19 — Régimen bloquea entradas durante rebote tras caída (escenario junio 2026)', () => {

  it('durante el rebote (candles 10-30): nunca allowShort=true', () => {
    // Build the full 60+168+30 = 258-candle scenario
    const fullCandles = buildJuneScenario(30)

    // Check at multiple points during the bounce (need ≥ 210 total candles)
    const bounceCheckpoints = [10, 15, 20, 25, 30]
    for (const bp of bounceCheckpoints) {
      const slice = fullCandles.slice(0, 60 + 168 + bp)
      const currentPrice = slice[slice.length - 1].close
      const result = analyzeRegime(slice, currentPrice)

      expect(
        result.allowShort,
        `allowShort debe ser false en bounce+${bp} ` +
        `(regime=${result.regime}, slope=${result.emaSlope4h.toFixed(2)}%, ` +
        `DI+=${result.diPlus.toFixed(1)}, DI-=${result.diMinus.toFixed(1)}, reason: ${result.reason})`
      ).toBe(false)

      // Regime must not be TRENDING_DOWN — that's the failure mode
      expect(
        result.regime,
        `regime no debe ser TRENDING_DOWN en bounce+${bp}`
      ).not.toBe('TRENDING_DOWN')
    }
  })

  it('peak del downtrend (168 candles caída): detecta bearish — allowLong=false', () => {
    // At the END of the downtrend, before any bounce
    const candles = buildJuneScenario(0)   // no bounce candles
    // Use 60+168 = 228 candles total (≥ 210 required)
    const currentPrice = candles[candles.length - 1].close
    const result = analyzeRegime(candles, currentPrice)

    // During a sustained 168-candle downtrend, regime should be bearish or ranging —
    // but NOT bullish. allowLong must be false.
    expect(result.allowLong).toBe(false)
    // ADX should be high (strong trend was building)
    expect(result.adx).toBeGreaterThan(ADX_TREND_REFERENCE)
  })

  it('el rebote final (bounce+30) produce allowShort=false independiente del EMA200', () => {
    const candles = buildJuneScenario(30)
    const currentPrice = candles[candles.length - 1].close
    const result = analyzeRegime(candles, currentPrice)

    // Key assertion: the regime is NOT TRENDING_DOWN regardless of EMA200 position.
    // DI+/slope detect the bounce direction; EMA200 is informational only (priceVsEma200 field).
    expect(result.allowShort).toBe(false)
    expect(result.regime).not.toBe('TRENDING_DOWN')
  })

  it('retorna todas las propiedades de RegimeAnalysis con tipos correctos', () => {
    const candles = buildJuneScenario(30)
    const currentPrice = candles[candles.length - 1].close
    const r = analyzeRegime(candles, currentPrice)

    expect(typeof r.regime).toBe('string')
    expect(['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'TRANSITION']).toContain(r.regime)
    expect(typeof r.adx).toBe('number')
    expect(typeof r.diPlus).toBe('number')
    expect(typeof r.diMinus).toBe('number')
    expect(typeof r.emaSlope4h).toBe('number')
    expect(typeof r.priceVsEma200).toBe('number')
    expect(typeof r.allowLong).toBe('boolean')
    expect(typeof r.allowShort).toBe('boolean')
    expect(typeof r.reason).toBe('string')
    expect(r.reason.length).toBeGreaterThan(0)

    // allowLong and allowShort must be mutually exclusive
    expect(r.allowLong && r.allowShort).toBe(false)
  })

  it('RANGING: ADX < 20 → allowLong=false, allowShort=false', () => {
    // Choppy candles → low ADX → RANGING
    const candles: Candle[] = []
    let price = 100
    for (let i = 0; i < 250; i++) {
      const open = price
      price = i % 2 === 0 ? open + 1 : open - 1
      const high = Math.max(open, price) + 0.5
      const low = Math.min(open, price) - 0.5
      candles.push(makeCandle(i, open, price, high, low))
    }
    const result = analyzeRegime(candles, price)

    expect(result.regime).toBe('RANGING')
    expect(result.allowLong).toBe(false)
    expect(result.allowShort).toBe(false)
  })
})

// Used in test above as a readable reference (not imported from regime to keep test self-contained)
const ADX_TREND_REFERENCE = 20
