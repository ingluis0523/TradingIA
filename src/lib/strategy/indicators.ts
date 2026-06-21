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

// ─── ADX (Wilder correcto) ────────────────────────────────────────────────────

export function adxFull(
  candles: Candle[],
  period = 14,
): { adx: number[]; diPlus: number[]; diMinus: number[] } {
  const n = candles.length
  const tr: number[] = new Array(n).fill(0)
  const plusDM: number[] = new Array(n).fill(0)
  const minusDM: number[] = new Array(n).fill(0)

  for (let i = 1; i < n; i++) {
    const { high, low } = candles[i]
    const { high: pHigh, low: pLow, close: pClose } = candles[i - 1]
    const upMove = high - pHigh
    const downMove = pLow - low
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0
    tr[i] = Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose))
  }

  // Wilder RMA: first value = simple average of first `period` values, then rma[i] = (rma[i-1]*(period-1) + x[i]) / period
  const wilderRMA = (arr: number[]): number[] => {
    const res: number[] = new Array(n).fill(NaN)
    if (n <= period) return res
    let sum = 0
    for (let i = 1; i <= period; i++) sum += arr[i]
    res[period] = sum / period
    for (let i = period + 1; i < n; i++) {
      res[i] = (res[i - 1] * (period - 1) + arr[i]) / period
    }
    return res
  }

  const atrRMA = wilderRMA(tr)
  const plusRMA = wilderRMA(plusDM)
  const minusRMA = wilderRMA(minusDM)

  const diPlusArr: number[] = new Array(n).fill(NaN)
  const diMinusArr: number[] = new Array(n).fill(NaN)
  const dx: number[] = new Array(n).fill(NaN)

  for (let i = period; i < n; i++) {
    if (isNaN(atrRMA[i]) || atrRMA[i] === 0) continue
    diPlusArr[i] = (plusRMA[i] / atrRMA[i]) * 100
    diMinusArr[i] = (minusRMA[i] / atrRMA[i]) * 100
    const diSum = diPlusArr[i] + diMinusArr[i]
    dx[i] = diSum === 0 ? 0 : (Math.abs(diPlusArr[i] - diMinusArr[i]) / diSum) * 100
  }

  // ADX = Wilder smoothing of DX (not EMA)
  const adxArr: number[] = new Array(n).fill(NaN)
  const firstDxIdx = dx.findIndex((v) => !isNaN(v))
  if (firstDxIdx === -1) return { adx: adxArr, diPlus: diPlusArr, diMinus: diMinusArr }

  const adxStartIdx = firstDxIdx + period - 1
  if (adxStartIdx >= n) return { adx: adxArr, diPlus: diPlusArr, diMinus: diMinusArr }

  let sumDx = 0
  let count = 0
  for (let i = firstDxIdx; i < firstDxIdx + period && i < n; i++) {
    if (!isNaN(dx[i])) { sumDx += dx[i]; count++ }
  }
  if (count === 0) return { adx: adxArr, diPlus: diPlusArr, diMinus: diMinusArr }

  adxArr[adxStartIdx] = sumDx / count
  for (let i = adxStartIdx + 1; i < n; i++) {
    adxArr[i] = isNaN(dx[i])
      ? adxArr[i - 1]
      : (adxArr[i - 1] * (period - 1) + dx[i]) / period
  }

  return { adx: adxArr, diPlus: diPlusArr, diMinus: diMinusArr }
}

// Wrapper for backward compatibility — callers that only need the ADX array
export function adx(candles: Candle[], period = 14): number[] {
  return adxFull(candles, period).adx
}

// ─── Squeeze Momentum (LazyBear) ─────────────────────────────────────────────
// Reference: https://www.tradingview.com/script/nqQ1DT5a-Squeeze-Momentum-Indicator-LazyBear/
// BB(20,2.0) vs KC(20, TR-based, 1.5), momentum via linreg of delta-source.

export interface SqueezeResult {
  val: number[]      // momentum histogram (linreg of delta-to-midrange)
  sqzOn: boolean[]   // true = BB inside KC (compression)
  sqzOff: boolean[]  // true = BB outside KC (release)
}

function stdev(values: number[], period: number): number[] {
  return values.map((_, i) => {
    if (i < period - 1) return NaN
    const slice = values.slice(i - period + 1, i + 1)
    const mean = slice.reduce((s, v) => s + v, 0) / period
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period
    return Math.sqrt(variance)
  })
}

function linreg(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN)
  const x = Array.from({ length: period }, (_, i) => i)
  const xMean = x.reduce((s, v) => s + v, 0) / period
  const denom = x.reduce((s, v) => s + (v - xMean) ** 2, 0)
  for (let i = period - 1; i < values.length; i++) {
    const w = values.slice(i - period + 1, i + 1)
    if (w.some(isNaN)) continue
    const yMean = w.reduce((s, v) => s + v, 0) / period
    const slope = x.reduce((s, xi, j) => s + (xi - xMean) * (w[j] - yMean), 0) / denom
    const intercept = yMean - slope * xMean
    out[i] = intercept + slope * (period - 1) // value of regression line at last point
  }
  return out
}

export function squeezeMomentum(
  candles: Candle[],
  bbLen = 20, bbMult = 2.0, kcLen = 20, kcMult = 1.5,
): SqueezeResult {
  const close = candles.map(c => c.close)
  const high  = candles.map(c => c.high)
  const low   = candles.map(c => c.low)
  const n = candles.length

  // BB
  const basis  = sma(close, bbLen)
  const dev    = stdev(close, bbLen)
  const upperBB = basis.map((b, i) => b + bbMult * dev[i])
  const lowerBB = basis.map((b, i) => b - bbMult * dev[i])

  // KC — uses true-range SMA (not ATR Wilder) to match LazyBear
  const ma = sma(close, kcLen)
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low
    const pc = candles[i - 1].close
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc))
  })
  const rangeMA = sma(tr, kcLen)
  const upperKC = ma.map((m, i) => m + rangeMA[i] * kcMult)
  const lowerKC = ma.map((m, i) => m - rangeMA[i] * kcMult)

  const sqzOn:  boolean[] = new Array(n).fill(false)
  const sqzOff: boolean[] = new Array(n).fill(false)
  for (let i = 0; i < n; i++) {
    if (isNaN(lowerBB[i]) || isNaN(lowerKC[i])) continue
    sqzOn[i]  = lowerBB[i] > lowerKC[i] && upperBB[i] < upperKC[i]
    sqzOff[i] = lowerBB[i] < lowerKC[i] && upperBB[i] > upperKC[i]
  }

  // Momentum source: close − avg(avg(highest_high, lowest_low), sma(close))
  const hh: number[] = new Array(n).fill(NaN)
  const ll: number[] = new Array(n).fill(NaN)
  for (let i = kcLen - 1; i < n; i++) {
    hh[i] = Math.max(...high.slice(i - kcLen + 1, i + 1))
    ll[i] = Math.min(...low.slice(i - kcLen + 1, i + 1))
  }
  const smaClose = sma(close, kcLen)
  const source = close.map((c, i) => c - (((hh[i] + ll[i]) / 2) + smaClose[i]) / 2)

  const val = linreg(source, kcLen)

  return { val, sqzOn, sqzOff }
}

// ─── 4h → Daily aggregation ───────────────────────────────────────────────────
// Used to compute EMA200 daily for the Merino macro filter.
// Assumes candles are sorted ascending by openTime.

export function aggregate4hToDaily(candles4h: Candle[]): Candle[] {
  const byDay = new Map<number, Candle[]>()
  for (const c of candles4h) {
    const dayKey = Math.floor(c.openTime / 86_400_000) * 86_400_000
    if (!byDay.has(dayKey)) byDay.set(dayKey, [])
    byDay.get(dayKey)!.push(c)
  }
  const daily: Candle[] = []
  const entries = Array.from(byDay.entries()).sort((a, b) => a[0] - b[0])
  for (const [dayKey, group] of entries) {
    daily.push({
      openTime:  dayKey,
      open:      group[0].open,
      high:      Math.max(...group.map(c => c.high)),
      low:       Math.min(...group.map(c => c.low)),
      close:     group[group.length - 1].close,
      volume:    group.reduce((s, c) => s + c.volume, 0),
      closeTime: group[group.length - 1].closeTime,
    })
  }
  return daily
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
  const { adx: adxValues, diPlus: diPlusValues, diMinus: diMinusValues } = adxFull(candles, cfg.adxPeriod)
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
    diPlus14: diPlusValues[last],
    diMinus14: diMinusValues[last],
  }
}

export function calculateIndicatorsPrev(candles: Candle[]): Indicators {
  return calculateIndicators(candles.slice(0, -1))
}
