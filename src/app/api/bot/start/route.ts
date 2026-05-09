import { NextResponse } from 'next/server'
import { getBotConfig, updateBotConfig, addLog } from '@/lib/supabase'
import { TRADING_SYMBOLS } from '@/types/trading'

export async function POST() {
  try {
    const config = await getBotConfig()

    if (config?.isRunning) {
      return NextResponse.json({ success: false, message: 'Bot ya está corriendo' })
    }

    await updateBotConfig({
      isRunning: true,
      symbols: config?.symbols || TRADING_SYMBOLS,
      leverage: config?.leverage || Number(process.env.BOT_DEFAULT_LEVERAGE || 3),
      riskPerTrade: config?.riskPerTrade || Number(process.env.BOT_RISK_PER_TRADE || 0.02),
      maxPositions: config?.maxPositions || Number(process.env.BOT_MAX_POSITIONS || 3),
      maxDailyLoss: config?.maxDailyLoss || Number(process.env.BOT_MAX_DAILY_LOSS || 0.05),
      initialCapital: config?.initialCapital || Number(process.env.BOT_INITIAL_CAPITAL || 1000),
      currentCapital: config?.currentCapital || Number(process.env.BOT_INITIAL_CAPITAL || 1000),
      marginType: config?.marginType || 'ISOLATED',
      strategy: config?.strategy || 'AMSS',
      timeframe: config?.timeframe || '1h',
    })

    await addLog({
      level: 'SUCCESS',
      message: '🚀 Bot iniciado correctamente',
      timestamp: new Date().toISOString(),
    })

    return NextResponse.json({ success: true, message: 'Bot iniciado' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
