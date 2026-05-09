export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { get24hTickers } from '@/lib/binance'
import { TRADING_SYMBOLS } from '@/types/trading'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  try {
    const tickers = await get24hTickers(TRADING_SYMBOLS)
    return NextResponse.json(tickers, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
