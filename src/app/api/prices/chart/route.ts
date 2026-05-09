import { NextRequest, NextResponse } from 'next/server'
import { getKlines } from '@/lib/binance'
import type { TradingSymbol } from '@/types/trading'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const symbol = (searchParams.get('symbol') || 'BTCUSDT') as TradingSymbol
  const interval = searchParams.get('interval') || '1h'
  const limit = parseInt(searchParams.get('limit') || '100')

  try {
    const candles = await getKlines(symbol, interval, Math.min(limit, 500))
    return NextResponse.json(candles)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
