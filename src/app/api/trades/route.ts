export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getOpenTrades, getRecentTrades, updateTrade } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const limit = parseInt(searchParams.get('limit') || '50')

  try {
    const trades = status === 'open'
      ? await getOpenTrades()
      : await getRecentTrades(limit)
    return NextResponse.json(trades)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, ...updates } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await updateTrade(id, updates)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
