import { addLogForUser } from '@/lib/supabase'
import type { TradingSymbol } from '@/types/trading'

export interface SignalTrace {
  symbol: TradingSymbol
  price: number
  regime: {
    name: string
    adx: number
    diPlus: number
    diMinus: number
    slope: number
    allowLong: boolean
    allowShort: boolean
  }
  filters1h?: {
    macdBullish: boolean
    macdBearish: boolean
    macdHist: number
    macdHistPrev: number
    rsiLong: boolean
    rsiShort: boolean
    rsi14: number
    stBullish: boolean
    stBearish: boolean
    stDirection: 'UP' | 'DOWN'
    volumeConfirmed: boolean
    volumeRatio: number
    trendStrong1h: boolean
    adx1h: number
    adxMin: number
  }
  outcome: 'SIGNAL_LONG' | 'SIGNAL_SHORT' | 'BLOCKED_REGIME' | 'BLOCKED_1H_FILTERS' | 'BLOCKED_INSUFFICIENT_DATA'
  blockingFilters?: string[]
  signalStrength?: number
}

export async function logSignalTrace(userId: string, trace: SignalTrace): Promise<void> {
  const r = trace.regime
  const regimeStr = `${r.name} (ADX ${r.adx.toFixed(1)}, DI+ ${r.diPlus.toFixed(1)}/DI- ${r.diMinus.toFixed(1)}, slope ${r.slope >= 0 ? '+' : ''}${r.slope.toFixed(2)}%)`

  let msgSummary: string
  switch (trace.outcome) {
    case 'BLOCKED_REGIME':
      msgSummary = `🔵 ${trace.symbol}: ${regimeStr} → sin entrada (régimen no operable)`
      break
    case 'BLOCKED_1H_FILTERS':
      msgSummary = `🟡 ${trace.symbol}: ${regimeStr} → falló filtros 1h: ${trace.blockingFilters?.join(', ')}`
      break
    case 'SIGNAL_LONG':
      msgSummary = `🟢 ${trace.symbol}: ${regimeStr} → SEÑAL LONG (strength ${trace.signalStrength})`
      break
    case 'SIGNAL_SHORT':
      msgSummary = `🟢 ${trace.symbol}: ${regimeStr} → SEÑAL SHORT (strength ${trace.signalStrength})`
      break
    case 'BLOCKED_INSUFFICIENT_DATA':
      msgSummary = `⚫ ${trace.symbol}: datos insuficientes (menos de 210 velas)`
      break
  }

  await addLogForUser(userId, {
    level: 'DEBUG',
    message: msgSummary!,
    data: trace as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  })
}
