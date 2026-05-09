import { NextResponse } from 'next/server'
import { runTradingTick } from '@/lib/trading-engine'

// Manual trigger for the trading tick (used from dashboard)

export async function POST() {
  try {
    const result = await runTradingTick()
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
