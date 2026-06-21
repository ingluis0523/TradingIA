import type { Candle, Signal, TradingSymbol } from '@/types/trading'
import { squeezeMomentum, aggregate4hToDaily, ema, atr, adx } from './indicators'
import { addLogForUser } from '@/lib/supabase'

const STRATEGY_SYMBOLS: TradingSymbol[] = ['BTCUSDT', 'BNBUSDT', 'ADAUSDT', 'DOTUSDT']

const EMA_FAST = 10
const EMA_SLOW = 55
const ADX_MIN = 20
const ADX_SLOPE_PERIODS = 3
const SQUEEZE_LOOKBACK = 4
const SL_ATR_MULT = 2.5
const TP1_ATR_MULT = 3.0
const TP2_ATR_MULT = 6.0
const EMA_MACRO_PERIOD = 200

export interface SignalContext {
  symbol: TradingSymbol
  candles4h: Candle[]
  candles1h?: Candle[]  // kept optional for backward compat — engine still passes it
  currentPrice: number
  slAtrMult?: number
  tp1AtrMult?: number
  tp2AtrMult?: number
  userId?: string
  traceEnabled?: boolean
}

export async function generateSignal(ctx: SignalContext): Promise<Signal | null> {
  const { symbol, candles4h, currentPrice, userId, traceEnabled = true } = ctx
  const shouldTrace = traceEnabled && userId !== undefined

  if (!STRATEGY_SYMBOLS.includes(symbol)) return null

  if (candles4h.length < 300) {
    if (shouldTrace) {
      await addLogForUser(userId!, {
        level: 'DEBUG',
        message: `[${symbol}] BLOCKED_INSUFFICIENT_DATA: ${candles4h.length} velas 4h (mín 300)`,
        data: { symbol, candles4h: candles4h.length, outcome: 'BLOCKED_INSUFFICIENT_DATA' },
        timestamp: new Date().toISOString(),
      })
    }
    return null
  }

  const close = candles4h.map(c => c.close)
  const last = candles4h.length - 1

  const emaFast = ema(close, EMA_FAST)
  const emaSlow = ema(close, EMA_SLOW)
  const { val: sqzVal, sqzOn, sqzOff } = squeezeMomentum(candles4h)
  const adxArr = adx(candles4h, 14)
  const atrArr = atr(candles4h, 14)

  const daily = aggregate4hToDaily(candles4h)
  const emaMacroDaily = ema(daily.map(c => c.close), EMA_MACRO_PERIOD)
  const macroEma = emaMacroDaily[emaMacroDaily.length - 1]

  const atrVal = atrArr[last]
  if (!atrVal || atrVal === 0) return null
  if ([emaFast[last], emaSlow[last], sqzVal[last], adxArr[last], macroEma].some(v => isNaN(v))) return null
  if (last < ADX_SLOPE_PERIODS || isNaN(adxArr[last - ADX_SLOPE_PERIODS])) return null

  const longBias = emaFast[last] > emaSlow[last]
  const recentSqueeze = sqzOn.slice(Math.max(0, last - SQUEEZE_LOOKBACK), last).some(Boolean)
  const squeezeReleased = sqzOff[last] && recentSqueeze
  const momentumUp = sqzVal[last] > 0 && sqzVal[last] > sqzVal[last - 1]
  const adxStrong = adxArr[last] > ADX_MIN && adxArr[last] > adxArr[last - ADX_SLOPE_PERIODS]
  const macroOk = currentPrice > macroEma

  const isLong = longBias && squeezeReleased && momentumUp && adxStrong && macroOk

  if (!isLong) {
    if (shouldTrace) {
      const blocking: string[] = []
      if (!longBias)         blocking.push(`EMA10<EMA55 (sin sesgo alcista)`)
      if (!squeezeReleased)  blocking.push(`sin squeeze release`)
      if (!momentumUp)       blocking.push(`momentum no alcista (${sqzVal[last].toFixed(4)})`)
      if (!adxStrong)        blocking.push(`ADX débil/plano (${adxArr[last].toFixed(1)})`)
      if (!macroOk)          blocking.push(`bajo EMA200 diaria (${currentPrice.toFixed(2)} < ${macroEma.toFixed(2)})`)
      await addLogForUser(userId!, {
        level: 'DEBUG',
        message: `[${symbol}] NO_SIGNAL: ${blocking.join(' | ')}`,
        data: { symbol, price: currentPrice, outcome: 'BLOCKED', blockingFilters: blocking },
        timestamp: new Date().toISOString(),
      })
    }
    return null
  }

  const slMult  = ctx.slAtrMult  ?? SL_ATR_MULT
  const tp1Mult = ctx.tp1AtrMult ?? TP1_ATR_MULT
  const tp2Mult = ctx.tp2AtrMult ?? TP2_ATR_MULT

  const stopLoss    = currentPrice - atrVal * slMult
  const takeProfit1 = currentPrice + atrVal * tp1Mult
  const takeProfit2 = currentPrice + atrVal * tp2Mult

  const strength = calculateSignalStrength(adxArr[last], sqzVal[last])
  const reason = `MERINO LONG | EMA10>EMA55 | squeeze release | mom ${sqzVal[last].toFixed(4)} | ADX ${adxArr[last].toFixed(1)} | precio>EMA200d`

  if (shouldTrace) {
    await addLogForUser(userId!, {
      level: 'DEBUG',
      message: `[${symbol}] SIGNAL_LONG @ ${currentPrice} | ${reason}`,
      data: { symbol, price: currentPrice, outcome: 'SIGNAL_LONG', strength, stopLoss, takeProfit1, takeProfit2 },
      timestamp: new Date().toISOString(),
    })
  }

  return {
    symbol,
    type: 'LONG',
    strength,
    price: currentPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    indicators: {
      ema20: emaFast[last],
      ema50: emaSlow[last],
      ema200: macroEma,
      rsi14: 0,
      macdLine: 0,
      macdSignal: 0,
      macdHistogram: sqzVal[last],
      atr14: atrVal,
      bbUpper: 0,
      bbMiddle: 0,
      bbLower: 0,
      superTrend: 0,
      superTrendDirection: 'UP',
      volumeSMA20: 0,
      adx14: adxArr[last],
      diPlus14: 0,
      diMinus14: 0,
    },
    reason,
    timestamp: Date.now(),
    executed: false,
  }
}

function calculateSignalStrength(adxVal: number, sqzMom: number): number {
  let score = 50
  if (adxVal > 30) score += 20
  else if (adxVal > 25) score += 10
  if (sqzMom > 0) score += Math.min(20, sqzMom * 100)
  return Math.min(100, Math.max(0, Math.round(score)))
}

export function shouldCloseOnMomentumFlip(candles4h: Candle[], tp1Hit: boolean): boolean {
  if (!tp1Hit || candles4h.length < 30) return false
  const { val } = squeezeMomentum(candles4h)
  const last = val.length - 1
  return val[last] < 0 && val[last] < val[last - 1]
}

// stub — engine calls this signature; will be removed in section 3.4 engine update
export function shouldCloseEarly(
  _side: 'BUY' | 'SELL',
  _candles1h: Candle[],
  _currentPrice: number,
  _entryPrice: number,
): boolean {
  return false
}
