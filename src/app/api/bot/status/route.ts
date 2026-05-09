import { NextResponse } from 'next/server'
import { getBotConfig, getOpenTrades, getRecentLogs, getPerformanceMetrics } from '@/lib/supabase'
import type { Trade, BotLog } from '@/types/trading'
import { getAccountInfo } from '@/lib/binance'

export async function GET() {
  const errors: string[] = []

  let config = null
  try {
    config = await getBotConfig()
  } catch (e) {
    errors.push(`Supabase config: ${e instanceof Error ? e.message : String(e)}`)
  }

  let openTrades: Trade[] = []
  try {
    openTrades = await getOpenTrades()
  } catch (e) {
    errors.push(`Trades: ${e instanceof Error ? e.message : String(e)}`)
  }

  let logs: BotLog[] = []
  try {
    logs = await getRecentLogs(20)
  } catch (e) {
    errors.push(`Logs: ${e instanceof Error ? e.message : String(e)}`)
  }

  let metrics = null
  try {
    metrics = await getPerformanceMetrics()
  } catch (e) {
    errors.push(`Metrics: ${e instanceof Error ? e.message : String(e)}`)
  }

  let account = null
  try {
    account = await getAccountInfo()
  } catch (e) {
    errors.push(`Binance: ${e instanceof Error ? e.message : String(e)}`)
  }

  return NextResponse.json({
    config,
    openTrades,
    logs,
    metrics,
    account,
    serverTime: Date.now(),
    errors: errors.length > 0 ? errors : undefined,
  })
}
