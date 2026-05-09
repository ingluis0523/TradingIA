import { NextResponse } from 'next/server'
import { updateBotConfig, addLog } from '@/lib/supabase'

export async function POST() {
  try {
    await updateBotConfig({ isRunning: false })

    await addLog({
      level: 'WARN',
      message: '⏹️ Bot detenido manualmente',
      timestamp: new Date().toISOString(),
    })

    return NextResponse.json({ success: true, message: 'Bot detenido' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, message }, { status: 500 })
  }
}
