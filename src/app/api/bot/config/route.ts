import { NextRequest, NextResponse } from 'next/server'
import { getBotConfig, updateBotConfig } from '@/lib/supabase'
import type { BotConfig } from '@/types/trading'

export async function GET() {
  try {
    const config = await getBotConfig()
    return NextResponse.json(config)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body: Partial<BotConfig> = await req.json()
    await updateBotConfig(body)
    const updated = await getBotConfig()
    return NextResponse.json(updated)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
