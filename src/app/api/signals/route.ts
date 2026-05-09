import { NextRequest, NextResponse } from 'next/server'
import { getRecentSignals } from '@/lib/supabase'
import { generateSignal } from '@/lib/strategy/signals'
import { getKlines, get24hTickers } from '@/lib/binance'
import { TRADING_SYMBOLS } from '@/types/trading'
import type { TradingSymbol } from '@/types/trading'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const limit = parseInt(searchParams.get('limit') || '30')

  try {
    const signals = await getRecentSignals(limit)
    return NextResponse.json(signals)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Scan all symbols for signals (used by dashboard "scan now" button)
export async function POST() {
  try {
    const tickers = await get24hTickers(TRADING_SYMBOLS)
    const results: Array<{ symbol: TradingSymbol; signal: Awaited<ReturnType<typeof generateSignal>> }> = []

    for (const ticker of tickers) {
      const symbol = ticker.symbol as TradingSymbol
      try {
        const [candles1h, candles4h] = await Promise.all([
          getKlines(symbol, '1h', 250),
          getKlines(symbol, '4h', 250),
        ])
        const signal = await generateSignal({
          symbol,
          candles1h,
          candles4h,
          currentPrice: ticker.price,
        })
        results.push({ symbol, signal })
      } catch {
        results.push({ symbol, signal: null })
      }
    }

    return NextResponse.json(results.filter((r) => r.signal !== null))
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
