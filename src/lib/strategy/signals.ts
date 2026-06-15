import type { Candle, Signal, TradingSymbol, Indicators } from '@/types/trading'
import { calculateIndicators, calculateIndicatorsPrev } from './indicators'
import { analyzeRegime, type RegimeAnalysis } from './regime'

// ─── Per-symbol 1h filters ────────────────────────────────────────────────────
// 4h direction is now determined by analyzeRegime (DI+/DI- + EMA50 slope).

interface SymbolFilters {
  adxMin: number
  volumeMultiplier: number
}

const FILTERS_BY_SYMBOL: Record<TradingSymbol, SymbolFilters> = {
  BTCUSDT: { adxMin: 18, volumeMultiplier: 0.9 },
  ETHUSDT: { adxMin: 20, volumeMultiplier: 1.0 },
  SOLUSDT: { adxMin: 25, volumeMultiplier: 1.2 },
  BNBUSDT: { adxMin: 20, volumeMultiplier: 1.0 },
  XRPUSDT: { adxMin: 20, volumeMultiplier: 1.0 },
}

// ATR multiplier defaults — overridable per user via user_bot_config (migration 003)
const DEFAULT_SL_ATR_MULT  = 2.2
const DEFAULT_TP1_ATR_MULT = 2.0
const DEFAULT_TP2_ATR_MULT = 3.5

export interface SignalContext {
  symbol: TradingSymbol
  candles1h: Candle[]
  candles4h: Candle[]
  currentPrice: number
  slAtrMult?: number
  tp1AtrMult?: number
  tp2AtrMult?: number
}

// ─── Signal Generation ────────────────────────────────────────────────────────
// Strategy: Adaptive Multi-Signal — Regime (4h) → Momentum + Volume (1h)
//
// Long Entry:
//   - 4H regime: TRENDING_UP (DI+ > DI-, EMA50 slope > 0.5%)
//   - 1H MACD histogram positive AND growing
//   - 1H RSI 40-68
//   - 1H SuperTrend UP
//   - 1H volume > volumeSMA20 × multiplier
//   - 1H ADX > adxMin
//
// Short Entry:
//   - 4H regime: TRENDING_DOWN (DI- > DI+, EMA50 slope < -0.5%)
//   - 1H MACD histogram negative AND falling
//   - 1H RSI 32-60
//   - 1H SuperTrend DOWN
//   - 1H volume > volumeSMA20 × multiplier
//   - 1H ADX > adxMin

export async function generateSignal(ctx: SignalContext): Promise<Signal | null> {
  const { symbol, candles1h, candles4h, currentPrice } = ctx

  if (candles1h.length < 210 || candles4h.length < 210) return null

  // ── 4H Regime Filter ─────────────────────────────────────────────────────
  // RANGING and TRANSITION block all entries — no bias, let regime settle.
  const regime = analyzeRegime(candles4h, currentPrice)
  if (regime.regime === 'RANGING' || regime.regime === 'TRANSITION') return null

  const ind1h = calculateIndicators(candles1h)
  const ind1hPrev = calculateIndicatorsPrev(candles1h)

  const atr = ind1h.atr14
  if (!atr || atr === 0) return null

  const filters = FILTERS_BY_SYMBOL[symbol]

  // ── 1H MACD Momentum ──────────────────────────────────────────────────────
  const macdBullish = ind1h.macdHistogram > 0 && ind1h.macdHistogram > ind1hPrev.macdHistogram
  const macdBearish = ind1h.macdHistogram < 0 && ind1h.macdHistogram < ind1hPrev.macdHistogram

  // ── 1H RSI Filter ─────────────────────────────────────────────────────────
  const rsiLong  = ind1h.rsi14 >= 40 && ind1h.rsi14 <= 68
  const rsiShort = ind1h.rsi14 >= 32 && ind1h.rsi14 <= 60

  // ── SuperTrend ─────────────────────────────────────────────────────────────
  const stBullish = ind1h.superTrendDirection === 'UP'
  const stBearish = ind1h.superTrendDirection === 'DOWN'

  // ── Volume Confirmation ────────────────────────────────────────────────────
  const lastVol = candles1h[candles1h.length - 1].volume
  const volumeConfirmed = lastVol >= ind1h.volumeSMA20 * filters.volumeMultiplier

  // ── Trend Strength (1H) ────────────────────────────────────────────────────
  const trendStrong1h = ind1h.adx14 > filters.adxMin

  // ── Build Signal ──────────────────────────────────────────────────────────
  const isLong  = regime.allowLong  && macdBullish && rsiLong  && stBullish && volumeConfirmed && trendStrong1h
  const isShort = regime.allowShort && macdBearish && rsiShort && stBearish && volumeConfirmed && trendStrong1h

  if (!isLong && !isShort) return null

  const direction = isLong ? 1 : -1

  const slMult  = ctx.slAtrMult  ?? DEFAULT_SL_ATR_MULT
  const tp1Mult = ctx.tp1AtrMult ?? DEFAULT_TP1_ATR_MULT
  const tp2Mult = ctx.tp2AtrMult ?? DEFAULT_TP2_ATR_MULT

  const stopLoss   = currentPrice - direction * atr * slMult
  const takeProfit1 = currentPrice + direction * atr * tp1Mult
  const takeProfit2 = currentPrice + direction * atr * tp2Mult

  const strength = calculateSignalStrength(ind1h, regime, isLong, volumeConfirmed, currentPrice)
  const reason   = `${regime.reason} || 1H: ${buildReason(ind1h, isLong, atr, currentPrice)}`

  return {
    symbol,
    type: isLong ? 'LONG' : 'SHORT',
    strength,
    price: currentPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    indicators: ind1h,
    reason,
    timestamp: Date.now(),
    executed: false,
  }
}

function calculateSignalStrength(
  ind1h: Indicators,
  regime: RegimeAnalysis,
  isLong: boolean,
  volumeConfirmed: boolean,
  currentPrice: number,
): number {
  let score = 50

  // RSI position quality
  if (isLong  && ind1h.rsi14 >= 45 && ind1h.rsi14 <= 60) score += 10
  if (!isLong && ind1h.rsi14 >= 40 && ind1h.rsi14 <= 55) score += 10

  // MACD histogram strength
  const histStrength = Math.abs(ind1h.macdHistogram)
  if (histStrength > 0) score += Math.min(10, histStrength * 2)

  // Regime ADX bonus
  if (regime.adx > 28) score += 10
  else if (regime.adx > 22) score += 5

  // DI spread bonus
  const diSpread = Math.abs(regime.diPlus - regime.diMinus)
  if (diSpread > 15) score += 5

  // Volume confirmation
  if (volumeConfirmed) score += 5

  // BB position — CORRECTED: currentPrice vs bbMiddle, NOT macdLine
  const bbRange = ind1h.bbUpper - ind1h.bbMiddle
  const bbPosition = bbRange > 0 ? (currentPrice - ind1h.bbMiddle) / bbRange : 0
  if (isLong  && bbPosition < 0.5)  score += 5  // price below upper half → room to run
  if (!isLong && bbPosition > -0.5) score += 5  // price not yet near lower band → room to fall

  return Math.min(100, Math.max(0, Math.round(score)))
}

function buildReason(ind1h: Indicators, isLong: boolean, atr: number, price: number): string {
  const parts: string[] = []
  parts.push(`${isLong ? 'LONG' : 'SHORT'}`)
  parts.push(`RSI14: ${ind1h.rsi14.toFixed(1)}`)
  parts.push(`MACD hist: ${ind1h.macdHistogram.toFixed(4)}`)
  parts.push(`ATR: ${atr.toFixed(4)}`)
  parts.push(`ADX: ${ind1h.adx14.toFixed(1)}`)
  parts.push(`ST: ${ind1h.superTrendDirection}`)
  parts.push(`price: ${price.toFixed(2)}`)
  return parts.join(' | ')
}

// ─── Close Signal ─────────────────────────────────────────────────────────────

export function shouldCloseEarly(
  side: 'BUY' | 'SELL',
  candles1h: Candle[],
  currentPrice: number,
  entryPrice: number,
): boolean {
  if (candles1h.length < 210) return false
  const ind = calculateIndicators(candles1h)

  // RSI extreme overbought/oversold
  if (side === 'BUY'  && ind.rsi14 > 80) return true
  if (side === 'SELL' && ind.rsi14 < 20) return true

  // SuperTrend reversal
  if (side === 'BUY'  && ind.superTrendDirection === 'DOWN') return true
  if (side === 'SELL' && ind.superTrendDirection === 'UP')   return true

  return false
}
