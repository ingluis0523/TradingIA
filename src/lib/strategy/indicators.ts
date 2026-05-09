import type { Candle, Indicators, IndicatorConfig } from '@/types/trading'

// ─── Moving Averages ──────────────────────────────────────────────────────────

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = []
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period
  result.push(...new Array(period - 1).fill(NaN))
  result.push(prev)
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    result.push(prev)
  }
  return result
}

export function sma(values: number[], period: number): number[] {
  return values.map((_, i) =>
    i < period - 1
      ? NaN
      : values.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period
  )
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

export function rsi(closes: number[], period = 14): number[] {
  const changes = closes.slice(1).map((v, i) => v - closes[i])
  const gains = changes.map((c) => (c > 0 ? c : 0))
  const losses = changes.map((c) => (c < 0 ? -c : 0))

  const result: number[] = new Array(period).fill(NaN)
  let avgGain = gains.slice(0, period).reduce((s, v) => s + v, 0) / period
  let avgLoss = losses.slice(0, period).reduce((s, v) => s + v, 0) / period

  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))

  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  }
  return result
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9
): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const emaFast = ema(closes, fast)
  const emaSlow = ema(closes, slow)
  const macdLine = emaFast.map((v, i) => (isNaN(v) || isNaN(emaSlow[i]) ? NaN : v - emaSlow[i]))
  const validMacd = macdLine.filter((v) => !isNaN(v))
  const signalValues = ema(validMacd, signal)
  const signalLine: number[] = new Array(macdLine.length - signalValues.length).fill(NaN).concat(signalValues)
  const histogram = macdLine.map((v, i) => (isNaN(v) || isNaN(signalLine[i]) ? NaN : v - signalLine[i]))
  return { macdLine, signalLine, histogram }
}

// ─── ATR ──────────────────────────────────────────────────────────────────────

export function atr(candles: Candle[], period = 14): number[] {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low
    const prev = candles[i - 1].close
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev))
  })
  const result: number[] = [NaN]
  let prevAtr = tr.slice(1, period + 1).reduce((s, v) => s + v, 0) / period
  result.push(...new Array(period - 1).fill(NaN))
  result.push(prevAtr)
  for (let i = period + 1; i < candles.length; i++) {
    prevAtr = (prevAtr * (period - 1) + tr[i]) / period
    result.push(prevAtr)
  }
  return result
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

export function bollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = sma(closes, period)
  const upper: number[] = []
  const lower: number[] = []
  closes.forEach((_, i) => {
    if (i < period - 1) {
      upper.push(NaN)
      lower.push(NaN)
      return
    }
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = middle[i]
    const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period
    const std = Math.sqrt(variance)
    upper.push(mean + stdDevMultiplier * std)
    lower.push(mean - stdDevMultiplier * std)
  })
  return { upper, middle, lower }
}

// ─── SuperTrend ───────────────────────────────────────────────────────────────

export function superTrend(
  candles: Candle[],
  period = 7,
  multiplier = 3
): { values: number[]; directions: ('UP' | 'DOWN')[] } {
  const atrValues = atr(candles, period)
  const values: number[] = []
  const directions: ('UP' | 'DOWN')[] = []

  let upperBand = 0, lowerBand = 0
  let direction: 'UP' | 'DOWN' = 'UP'

  for (let i = 0; i < candles.length; i++) {
    const { high, low, close } = candles[i]
    const a = isNaN(atrValues[i]) ? 0 : atrValues[i]
    const hl2 = (high + low) / 2
    const basicUpper = hl2 + multiplier * a
    const basicLower = hl2 - multiplier * a

    if (i === 0) {
      upperBand = basicUpper
      lowerBand = basicLower
      values.push(lowerBand)
      directions.push('UP')
      continue
    }

    const prevClose = candles[i - 1].close
    const prevUpper = upperBand
    const prevLower = lowerBand

    upperBand = basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper
    lowerBand = basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower

    if (direction === 'UP' && close < lowerBand) direction = 'DOWN'
    else if (direction === 'DOWN' && close > upperBand) direction = 'UP'

    values.push(direction === 'UP' ? lowerBand : upperBand)
    directions.push(direction)
  }
  return { values, directions }
}

// ─── ADX ──────────────────────────────────────────────────────────────────────

export function adx(candles: Candle[], period = 14): number[] {
  const plusDM: number[] = [0]
  const minusDM: number[] = [0]
  const tr: number[] = [0]

  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i]
    const { high: pHigh, low: pLow, close: pClose } = candles[i - 1]
    const upMove = high - pHigh
    const downMove = pLow - low
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
    tr.push(Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose)))
  }

  const smooth = (arr: number[], p: number) => {
    const result: number[] = new Array(p).fill(NaN)
    let s = arr.slice(1, p + 1).reduce((a, b) => a + b, 0)
    result.push(s)
    for (let i = p + 1; i < arr.length; i++) {
      s = s - s / p + arr[i]
      result.push(s)
    }
    return result
  }

  const strTR = smooth(tr, period)
  const strPlus = smooth(plusDM, period)
  const strMinus = smooth(minusDM, period)

  const diPlus = strPlus.map((v, i) => (isNaN(strTR[i]) || strTR[i] === 0 ? NaN : (v / strTR[i]) * 100))
  const diMinus = strMinus.map((v, i) => (isNaN(strTR[i]) || strTR[i] === 0 ? NaN : (v / strTR[i]) * 100))
  const dx = diPlus.map((v, i) => {
    const sum = v + diMinus[i]
    return isNaN(v) || sum === 0 ? NaN : (Math.abs(v - diMinus[i]) / sum) * 100
  })

  const validDx = dx.filter((v) => !isNaN(v))
  const adxSmoothed = ema(validDx, period)
  return new Array(dx.length - adxSmoothed.length).fill(NaN).concat(adxSmoothed)
}

// ─── Volume MA ────────────────────────────────────────────────────────────────

export function volumeMA(candles: Candle[], period = 20): number[] {
  const volumes = candles.map((c) => c.volume)
  return sma(volumes, period)
}

// ─── Main Calculate Indicators ────────────────────────────────────────────────

export function calculateIndicators(candles: Candle[], config?: Partial<IndicatorConfig>): Indicators {
  const cfg = {
    ema20Period: 20, ema50Period: 50, ema200Period: 200,
    rsiPeriod: 14, macdFast: 12, macdSlow: 26, macdSignal: 9,
    atrPeriod: 14, bbPeriod: 20, bbStdDev: 2,
    superTrendPeriod: 7, superTrendMultiplier: 3, adxPeriod: 14,
    ...config,
  }

  if (candles.length < 210) throw new Error(`Need at least 210 candles, got ${candles.length}`)

  const closes = candles.map((c) => c.close)
  const last = candles.length - 1

  const ema20Values = ema(closes, cfg.ema20Period)
  const ema50Values = ema(closes, cfg.ema50Period)
  const ema200Values = ema(closes, cfg.ema200Period)
  const rsiValues = rsi(closes, cfg.rsiPeriod)
  const { macdLine, signalLine, histogram } = macd(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal)
  const atrValues = atr(candles, cfg.atrPeriod)
  const { upper, middle, lower } = bollingerBands(closes, cfg.bbPeriod, cfg.bbStdDev)
  const { values: stValues, directions: stDirections } = superTrend(candles, cfg.superTrendPeriod, cfg.superTrendMultiplier)
  const adxValues = adx(candles, cfg.adxPeriod)
  const volMA = volumeMA(candles, 20)

  return {
    ema20: ema20Values[last],
    ema50: ema50Values[last],
    ema200: ema200Values[last],
    rsi14: rsiValues[last],
    macdLine: macdLine[last],
    macdSignal: signalLine[last],
    macdHistogram: histogram[last],
    atr14: atrValues[last],
    bbUpper: upper[last],
    bbMiddle: middle[last],
    bbLower: lower[last],
    superTrend: stValues[last],
    superTrendDirection: stDirections[last],
    volumeSMA20: volMA[last],
    adx14: adxValues[last],
  }
}

export function calculateIndicatorsPrev(candles: Candle[]): Indicators {
  return calculateIndicators(candles.slice(0, -1))
}
