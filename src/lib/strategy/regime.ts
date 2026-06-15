import type { Candle } from '@/types/trading'
import { calculateIndicators, ema } from './indicators'

export type MarketRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'TRANSITION'

export interface RegimeAnalysis {
  regime: MarketRegime
  adx: number
  diPlus: number
  diMinus: number
  emaSlope4h: number      // % change of EMA50 over last 6 × 4h candles (≈ 24h momentum)
  priceVsEma200: number   // % distance of currentPrice from EMA200 4h
  allowLong: boolean
  allowShort: boolean
  reason: string
}

// ─── Thresholds (named constants — never magic numbers in conditions) ──────────

const ADX_TREND = 20       // ADX below this → no clear trend → RANGING
const ADX_STRONG = 28      // reserved: used for signal-strength bonus in signals.ts
const SLOPE_FLAT = 0.5     // |EMA50 slope %| below this → considered flat
const EMA_SLOPE_LOOKBACK = 6  // 4h candles to measure EMA50 momentum (= 24h)

export { ADX_TREND, ADX_STRONG, SLOPE_FLAT }

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Classifies the current market regime from 4h candles.
 *
 * Key design decision: direction is determined by DI+/DI− (reacts in ~14 candles)
 * confirmed by EMA50 slope over the last 24h, NOT by EMA200 distance.
 * EMA200 gets anchored at the previous regime level for days after a reversal,
 * causing the bot to open SHORTs into bounces — the exact failure mode of June 2026.
 *
 * When DI and slope disagree (regime transition), the function returns TRANSITION
 * and blocks all entries rather than betting on the wrong direction.
 */
export function analyzeRegime(candles4h: Candle[], currentPrice: number): RegimeAnalysis {
  const ind = calculateIndicators(candles4h)

  // EMA50 slope: % change over the last EMA_SLOPE_LOOKBACK × 4h candles
  const closes = candles4h.map((c) => c.close)
  const ema50Series = ema(closes, 50)
  const last = ema50Series.length - 1
  const refIdx = last - EMA_SLOPE_LOOKBACK
  const emaSlope4h =
    refIdx >= 0 && !isNaN(ema50Series[refIdx]) && ema50Series[refIdx] !== 0
      ? ((ema50Series[last] - ema50Series[refIdx]) / ema50Series[refIdx]) * 100
      : 0

  const priceVsEma200 = ind.ema200 !== 0
    ? ((currentPrice - ind.ema200) / ind.ema200) * 100
    : 0

  const adxVal  = ind.adx14
  const diPlus  = ind.diPlus14
  const diMinus = ind.diMinus14

  let regime: MarketRegime
  let allowLong  = false
  let allowShort = false
  let reason: string

  if (adxVal < ADX_TREND) {
    // No clear trend — mean-reversion entries not implemented yet, so block all
    regime = 'RANGING'
    reason = `ADX ${adxVal.toFixed(1)} < ${ADX_TREND}: mercado en rango, sin entradas de tendencia`
  } else {
    const diBullish   = diPlus > diMinus
    const slopeBullish = emaSlope4h >  SLOPE_FLAT
    const slopeBearish = emaSlope4h < -SLOPE_FLAT

    if (diBullish && slopeBullish) {
      regime    = 'TRENDING_UP'
      allowLong = true
      reason    = `Tendencia alcista: ADX ${adxVal.toFixed(1)}, DI+ ${diPlus.toFixed(1)} > DI- ${diMinus.toFixed(1)}, EMA50 4h subiendo ${emaSlope4h.toFixed(2)}%`
    } else if (!diBullish && slopeBearish) {
      regime     = 'TRENDING_DOWN'
      allowShort = true
      reason     = `Tendencia bajista: ADX ${adxVal.toFixed(1)}, DI- ${diMinus.toFixed(1)} > DI+ ${diPlus.toFixed(1)}, EMA50 4h bajando ${emaSlope4h.toFixed(2)}%`
    } else {
      // DI and slope disagree → regime is changing, do not trade
      regime = 'TRANSITION'
      reason = `Transicion de regimen: DI ${diBullish ? 'alcista' : 'bajista'} pero pendiente ${emaSlope4h.toFixed(2)}% discrepa. Sin entradas.`
    }
  }

  return { regime, adx: adxVal, diPlus, diMinus, emaSlope4h, priceVsEma200, allowLong, allowShort, reason }
}
