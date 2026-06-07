import { NextResponse } from 'next/server'
import { getBotConfig, updateBotConfig, addLog, updateUserBotConfig, SYSTEM_USER_ID } from '@/lib/supabase'
import { TRADING_SYMBOLS } from '@/types/trading'

export async function POST() {
  try {
    const config = await getBotConfig()

    if (config?.isRunning) {
      return NextResponse.json({ success: false, message: 'Bot ya está corriendo' })
    }

    const symbols = config?.symbols || TRADING_SYMBOLS
    const leverage = config?.leverage || Number(process.env.BOT_DEFAULT_LEVERAGE || 3)
    const riskPerTrade = config?.riskPerTrade || Number(process.env.BOT_RISK_PER_TRADE || 0.02)
    const maxPositions = config?.maxPositions || Number(process.env.BOT_MAX_POSITIONS || 3)
    const maxDailyLoss = config?.maxDailyLoss || Number(process.env.BOT_MAX_DAILY_LOSS || 0.05)
    const initialCapital = config?.initialCapital || Number(process.env.BOT_INITIAL_CAPITAL || 1000)
    const strategy = config?.strategy || 'AMSS'
    const timeframe = config?.timeframe || '1h'

    // Update dashboard-facing config
    await updateBotConfig({
      isRunning: true,
      symbols,
      leverage,
      riskPerTrade,
      maxPositions,
      maxDailyLoss,
      initialCapital,
      currentCapital: config?.currentCapital || initialCapital,
      marginType: config?.marginType || 'ISOLATED',
      strategy,
      timeframe,
    })

    // Update engine-facing config
    await updateUserBotConfig(SYSTEM_USER_ID, {
      isRunning: true,
      symbols,
      leverage,
      riskPerTrade,
      maxPositions,
      maxDailyLoss,
      strategy,
      timeframe,
    })

    await addLog({ level: 'SUCCESS', message: '🚀 Bot iniciado correctamente', timestamp: new Date().toISOString() })
    return NextResponse.json({ success: true, message: 'Bot iniciado' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
