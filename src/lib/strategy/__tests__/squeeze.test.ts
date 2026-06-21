/**
 * Test M1 — squeezeMomentum (LazyBear) implementation correctness
 *
 * Validates against analytically-derived expected values for two synthetic series:
 *   A) Flat-price series (close=100, high=101, low=99) — all values computable by hand
 *   B) Rising-price series — verifies directional correctness
 *
 * Key invariants from LazyBear reference:
 *   • sqzOn = true  when BB is INSIDE KC (compression)
 *   • sqzOff = true when BB is OUTSIDE KC (expansion)
 *   • sqzOn and sqzOff are mutually exclusive
 *   • val = linreg(source, kcLen) where source = close - avg(midHL20, sma20)
 *
 * Analytical derivation for flat series (close=100, high=101, low=99):
 *   TR = max(2, |101-100|, |99-100|) = 2
 *   rangeMA(20) = 2  → lowerKC = 100 - 1.5*2 = 97,  upperKC = 100 + 1.5*2 = 103
 *   stdev(20) = 0    → lowerBB = upperBB = 100
 *   sqzOn:  100 > 97 AND 100 < 103 → TRUE
 *   sqzOff: 100 < 97 AND 100 > 103 → FALSE
 *   hh=101, ll=99, smaClose=100
 *   source = 100 - ((101+99)/2 + 100)/2 = 100 - 100 = 0
 *   linreg([0,0,...], 20) = 0  → val = 0.0
 */

import { describe, it, expect } from 'vitest'
import { squeezeMomentum, aggregate4hToDaily } from '../indicators'
import type { Candle } from '@/types/trading'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MS_4H = 4 * 3600 * 1000

function makeCandle(i: number, o: number, c: number, h: number, l: number, vol = 1000): Candle {
  return {
    openTime:  i * MS_4H,
    open: o, close: c, high: h, low: l,
    volume: vol,
    closeTime: (i + 1) * MS_4H - 1,
  }
}

function makeFlatCandles(n: number): Candle[] {
  // close=100, high=101, low=99 — all values identical → stdev=0, TR=2
  return Array.from({ length: n }, (_, i) => makeCandle(i, 100, 100, 101, 99))
}

function makeRisingCandles(n: number): Candle[] {
  // close increases by 1 per bar, tight range
  return Array.from({ length: n }, (_, i) =>
    makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i + 0.8, 100 + i - 0.3),
  )
}

function lastValid(arr: number[]): number {
  return [...arr].reverse().find(v => !isNaN(v)) ?? NaN
}

// ─── Test M1: structural invariants ──────────────────────────────────────────

describe('Test M1 — squeezeMomentum (LazyBear)', () => {
  const N = 60

  it('retorna arrays de la longitud correcta', () => {
    const result = squeezeMomentum(makeFlatCandles(N))
    expect(result.val).toHaveLength(N)
    expect(result.sqzOn).toHaveLength(N)
    expect(result.sqzOff).toHaveLength(N)
  })

  it('sqzOn y sqzOff son mutuamente excluyentes en cada barra', () => {
    const { sqzOn, sqzOff } = squeezeMomentum(makeFlatCandles(N))
    for (let i = 0; i < N; i++) {
      expect(sqzOn[i] && sqzOff[i], `barra ${i} no puede tener sqzOn y sqzOff simultáneos`).toBe(false)
    }
  })

  it('primeros 19 índices tienen NaN en val (warmup de period-1)', () => {
    const { val } = squeezeMomentum(makeFlatCandles(N))
    // linreg necesita bbLen(20) de source válida; source necesita kcLen(20) de datos → warmup total = 38
    for (let i = 0; i < 38; i++) {
      expect(val[i]).toBeNaN()
    }
  })

  // ── Derivación analítica — serie plana ────────────────────────────────────
  // TR=2, rangeMA=2, lowerKC=97, upperKC=103
  // stdev=0 → lowerBB=upperBB=100 → 100>97 AND 100<103 → sqzOn=true

  it('serie plana → sqzOn=true desde el índice 19 en adelante', () => {
    const { sqzOn, sqzOff } = squeezeMomentum(makeFlatCandles(N))
    for (let i = 19; i < N; i++) {
      expect(sqzOn[i], `sqzOn debe ser true en índice ${i}`).toBe(true)
      expect(sqzOff[i], `sqzOff debe ser false en índice ${i}`).toBe(false)
    }
  })

  it('serie plana → val = 0.0 exacto (source analítico = 0)', () => {
    // source = close - ((hh+ll)/2 + smaClose)/2 = 100 - ((101+99)/2 + 100)/2 = 0
    // linreg([0,...,0], 20) = 0
    const { val } = squeezeMomentum(makeFlatCandles(N))
    for (let i = 38; i < N; i++) {
      expect(val[i]).toBeCloseTo(0, 10)
    }
  })

  // ── Validación direccional — tendencia alcista ────────────────────────────
  // close rampea +1 por vela → source > 0 → val > 0 después de warmup

  it('tendencia alcista → val > 0 después del warmup', () => {
    const { val } = squeezeMomentum(makeRisingCandles(N))
    const finalVal = lastValid(val)
    expect(finalVal).not.toBeNaN()
    expect(finalVal).toBeGreaterThan(0)
  })

  it('tendencia bajista → val < 0 después del warmup', () => {
    // mirror del test alcista: close cae -1 por vela → source < 0 → val < 0
    const falling = Array.from({ length: N }, (_, i) =>
      makeCandle(i, 200 - i, 200 - i - 0.5, 200 - i + 0.3, 200 - i - 0.8),
    )
    const { val } = squeezeMomentum(falling)
    const finalVal = lastValid(val)
    expect(finalVal).not.toBeNaN()
    expect(finalVal).toBeLessThan(0)
  })

  it('sqzOff se activa eventualmente en tendencia fuerte (BB expande sobre KC)', () => {
    // Con alta volatilidad (ramp rápida), BB crece y supera a KC → sqzOff=true
    const fastRamp = Array.from({ length: 80 }, (_, i) =>
      makeCandle(i, 100 + i * 3, 100 + i * 3 + 1, 100 + i * 3 + 4, 100 + i * 3 - 1),
    )
    const { sqzOff } = squeezeMomentum(fastRamp)
    const anyOff = sqzOff.some(Boolean)
    expect(anyOff).toBe(true)
  })
})

// ─── Test M1b: aggregate4hToDaily ────────────────────────────────────────────

describe('Test M1b — aggregate4hToDaily', () => {
  // Día 0 UTC = 0ms, Día 1 UTC = 86_400_000ms
  // 6 velas 4h por día
  const DAY = 86_400_000

  function make4hCandles(nDays: number): Candle[] {
    const candles: Candle[] = []
    for (let d = 0; d < nDays; d++) {
      for (let h = 0; h < 6; h++) {
        const idx = d * 6 + h
        const base = 100 + d * 10 + h
        candles.push({
          openTime:  d * DAY + h * 4 * 3600_000,
          open:      base,
          close:     base + 1,
          high:      base + 2,
          low:       base - 1,
          volume:    1000,
          closeTime: d * DAY + (h + 1) * 4 * 3600_000 - 1,
        })
      }
    }
    return candles
  }

  it('agrega 12 velas 4h (2 días) en 2 velas diarias', () => {
    const candles4h = make4hCandles(2)
    const daily = aggregate4hToDaily(candles4h)
    expect(daily).toHaveLength(2)
  })

  it('open de la vela diaria = open de la primera 4h del día', () => {
    const daily = aggregate4hToDaily(make4hCandles(2))
    // Día 0: primera 4h tiene open=100
    expect(daily[0].open).toBe(100)
    // Día 1: primera 4h tiene open=110
    expect(daily[1].open).toBe(110)
  })

  it('close de la vela diaria = close de la última 4h del día', () => {
    const daily = aggregate4hToDaily(make4hCandles(2))
    // Día 0: última 4h (h=5) tiene close = 100+5+1 = 106
    expect(daily[0].close).toBe(106)
  })

  it('high diario = máximo de todas las 4h del día', () => {
    const daily = aggregate4hToDaily(make4hCandles(2))
    // Día 0: high máximo = 100+5+2 = 107 (última 4h tiene el precio más alto)
    expect(daily[0].high).toBe(107)
  })

  it('low diario = mínimo de todas las 4h del día', () => {
    const daily = aggregate4hToDaily(make4hCandles(2))
    // Día 0: low mínimo = 100+0-1 = 99 (primera 4h tiene el precio más bajo)
    expect(daily[0].low).toBe(99)
  })

  it('volume diario = suma de volúmenes de todas las 4h', () => {
    const daily = aggregate4hToDaily(make4hCandles(2))
    expect(daily[0].volume).toBe(6000) // 6 velas × 1000
  })

  it('con 30 días de velas 4h → 30 velas diarias', () => {
    const daily = aggregate4hToDaily(make4hCandles(30))
    expect(daily).toHaveLength(30)
  })
})
