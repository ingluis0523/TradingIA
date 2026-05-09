import { NextResponse } from 'next/server'
import { getAccountInfo } from '@/lib/binance'
import { getPerformanceMetrics } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [account, metrics] = await Promise.all([
      getAccountInfo(),
      getPerformanceMetrics(),
    ])
    return NextResponse.json({ account, metrics })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
