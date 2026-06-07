import { NextRequest, NextResponse } from 'next/server'
import { runTradingTick } from '@/lib/trading-engine'
import { addLog, isGlobalKillSwitchActive } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const cronAt = new Date().toISOString()
  await addLog({ level: 'INFO', message: `🕐 Cron recibido — ${cronAt}`, timestamp: cronAt })

  try {
    // Fast exit before spinning up the engine
    const killActive = await isGlobalKillSwitchActive()
    if (killActive) {
      await addLog({ level: 'WARN', message: '🛑 Kill switch activo — cron abortado', timestamp: new Date().toISOString() })
      return NextResponse.json({ success: true, message: 'Kill switch activo — trading suspendido' })
    }

    const result = await runTradingTick()
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await addLog({ level: 'ERROR', message: `❌ Cron error crítico: ${message}`, timestamp: new Date().toISOString() })
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
