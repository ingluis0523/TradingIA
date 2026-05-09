import { NextRequest, NextResponse } from 'next/server'
import { runTradingTick } from '@/lib/trading-engine'

// Called every minute by Vercel Cron
// Security: protected by CRON_SECRET header

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runTradingTick()
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
