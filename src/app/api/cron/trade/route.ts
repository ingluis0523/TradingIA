import { NextRequest, NextResponse } from 'next/server'
import { runTradingTick } from '@/lib/trading-engine'
import { addLog } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Write a heartbeat log immediately — before any engine logic
  const cronAt = new Date().toISOString()
  await addLog({ level: 'INFO', message: `🕐 Cron recibido — ${cronAt}`, timestamp: cronAt })

  try {
    const result = await runTradingTick()
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await addLog({ level: 'ERROR', message: `❌ Cron error crítico: ${message}`, timestamp: new Date().toISOString() })
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
