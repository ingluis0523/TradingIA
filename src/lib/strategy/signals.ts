import type { Candle, Signal, TradingSymbol, Indicators } from '@/types/trading'
import { calculateIndicators, calculateIndicatorsPrev } from './indicators'

export interface SignalContext {
  symbol: TradingSymbol
  candles1h: Candle[]
  candles4h: Candle[]
  currentPrice: number
}

// ─── Signal Generation ────────────────────────────────────────────────────────
// Strategy: Adaptive Multi-Signal (Trend + Momentum + Volume + Confirmation)
//
// Long Entry:
//   - 4H: EMA20 > EMA50 (trending up) AND price > EMA200
//   - 1H: MACD histogram turned positive (momentum shift up)
//   - 1H: RSI 35-65 (not extreme, has room to move)
//   - 1H: Price above SuperTrend (trend is up)
//   - 1H: Volume > Volume MA20 (confirmed move)
//   - 1H: ADX > 20 (trend strength)
//
// Short Entry:
//   - 4H: EMA20 < EMA50 (trending down) AND price < EMA200
//   - 1H: MACD histogram turned negative (momentum shift down)
//   - 1H: RSI 35-65
//   - 1H: Price below SuperTrend (trend is down)
//   - 1H: Volume > Volume MA20
//   - 1H: ADX > 20

export async function generateSignal(ctx: SignalContext): Promise<Signal | null> {
  const { symbol, candles1h, candles4h, currentPrice } = ctx

  if (candles1h.length < 210 || candles4h.length < 210) return null

  const ind1h = calculateIndicators(candles1h)
  const ind1hPrev = calculateIndicatorsPrev(candles1h)
  const ind4h = calculateIndicators(candles4h)

  const atr = ind1h.atr14
  if (!atr || atr === 0) return null

  // ── 4H Trend Filter ───────────────────────────────────────────────────────
  const bullishTrend4h = ind4h.ema20 > ind4h.ema50 && currentPrice > ind4h.ema200
  const bearishTrend4h = ind4h.ema20 < ind4h.ema50 && currentPrice < ind4h.ema200

  if (!bullishTrend4h && !bearishTrend4h) return null

  // ── 1H MACD Cross (momentum shift) ────────────────────────────────────────
  const macdCrossedUp =
    ind1hPrev.macdHistogram < 0 && ind1h.macdHistogram > 0
  const macdCrossedDown =
    ind1hPrev.macdHistogram > 0 && ind1h.macdHistogram < 0

  // ── 1H RSI Filter ─────────────────────────────────────────────────────────
  const rsiLong = ind1h.rsi14 >= 35 && ind1h.rsi14 <= 68
  const rsiShort = ind1h.rsi14 >= 32 && ind1h.rsi14 <= 65

  // ── SuperTrend ─────────────────────────────────────────────────────────────
  const stBullish = ind1h.superTrendDirection === 'UP'
  const stBearish = ind1h.superTrendDirection === 'DOWN'

  // ── Volume Confirmation ────────────────────────────────────────────────────
  const volumeConfirmed =
    candles1h[candles1h.length - 1].volume > ind1h.volumeSMA20 * 1.1

  // ── Trend Strength ─────────────────────────────────────────────────────────
  const trendStrong = ind1h.adx14 > 20

  // ── Build Signal ──────────────────────────────────────────────────────────
  const isLong =
    bullishTrend4h &&
    macdCrossedUp &&
    rsiLong &&
    stBullish &&
    volumeConfirmed &&
    trendStrong

  const isShort =
    bearishTrend4h &&
    macdCrossedDown &&
    rsiShort &&
    stBearish &&
    volumeConfirmed &&
    trendStrong

  if (!isLong && !isShort) return null

  const signalType = isLong ? 'LONG' : 'SHORT'
  const direction = isLong ? 1 : -1

  // SL: 1.5 ATR away from entry
  const stopLoss = currentPrice - direction * atr * 1.5
  const takeProfit1 = currentPrice + direction * atr * 2.5
  const takeProfit2 = currentPrice + direction * atr * 4.0

  const strength = calculateSignalStrength(ind1h, ind4h, isLong, volumeConfirmed)
  const reason = buildReason(ind1h, ind4h, isLong, atr, currentPrice)

  return {
    symbol,
    type: signalType,
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
  ind4h: Indicators,
  isLong: boolean,
  volumeConfirmed: boolean
): number {
  let score = 50

  // RSI position quality
  if (isLong && ind1h.rsi14 >= 45 && ind1h.rsi14 <= 60) score += 10
  if (!isLong && ind1h.rsi14 >= 40 && ind1h.rsi14 <= 55) score += 10

  // MACD histogram strength
  const histStrength = Math.abs(ind1h.macdHistogram)
  if (histStrength > 0) score += Math.min(10, histStrength * 2)

  // 4H EMA alignment bonus
  if (isLong && ind4h.ema20 > ind4h.ema50 && ind4h.ema50 > ind4h.ema200) score += 10
  if (!isLong && ind4h.ema20 < ind4h.ema50 && ind4h.ema50 < ind4h.ema200) score += 10

  // ADX strength
  if (ind1h.adx14 > 25) score += 5
  if (ind1h.adx14 > 35) score += 5

  // Volume confirmation
  if (volumeConfirmed) score += 5

  // Bollinger Band position
  const bbPosition = (ind1h.bbUpper - ind1h.bbMiddle) > 0
    ? (ind1h.macdLine - ind1h.bbMiddle) / (ind1h.bbUpper - ind1h.bbMiddle)
    : 0
  if (isLong && bbPosition < 0.5) score += 5
  if (!isLong && bbPosition > 0.5) score += 5

  return Math.min(100, Math.max(0, Math.round(score)))
}

function buildReason(
  ind1h: Indicators,
  ind4h: Indicators,
  isLong: boolean,
  atr: number,
  price: number
): string {
  const parts: string[] = []
  parts.push(`${isLong ? '📈 LONG' : '📉 SHORT'} signal detectado`)
  parts.push(`4H EMA20(${ind4h.ema20.toFixed(2)}) ${isLong ? '>' : '<'} EMA50(${ind4h.ema50.toFixed(2)})`)
  parts.push(`RSI14: ${ind1h.rsi14.toFixed(1)}`)
  parts.push(`MACD hist: ${ind1h.macdHistogram.toFixed(4)} (cruce ${isLong ? 'alcista' : 'bajista'})`)
  parts.push(`ATR: ${atr.toFixed(4)} | ADX: ${ind1h.adx14.toFixed(1)}`)
  parts.push(`SuperTrend: ${ind1h.superTrendDirection}`)
  return parts.join(' | ')
}

// ─── Close Signal ─────────────────────────────────────────────────────────────
// Returns true if the current trade should be closed early (risk management)

export function shouldCloseEarly(
  side: 'BUY' | 'SELL',
  candles1h: Candle[],
  currentPrice: number,
  entryPrice: number,
): boolean {
  if (candles1h.length < 210) return false
  const ind = calculateIndicators(candles1h)

  // RSI extreme overbought/oversold
  if (side === 'BUY' && ind.rsi14 > 80) return true
  if (side === 'SELL' && ind.rsi14 < 20) return true

  // SuperTrend reversal
  if (side === 'BUY' && ind.superTrendDirection === 'DOWN') return true
  if (side === 'SELL' && ind.superTrendDirection === 'UP') return true

  return false
}
