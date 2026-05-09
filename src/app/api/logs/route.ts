export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getRecentLogs } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const limit = parseInt(searchParams.get('limit') || '100')
  try {
    const logs = await getRecentLogs(limit)
    return NextResponse.json(logs)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
