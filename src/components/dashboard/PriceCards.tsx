'use client'
import { cn } from '@/lib/utils'
import type { Ticker } from '@/types/trading'
import { SYMBOL_INFO, TRADING_SYMBOLS } from '@/types/trading'
import { TrendingUp, TrendingDown } from 'lucide-react'

interface PriceCardsProps {
  tickers: Ticker[]
}

export function PriceCards({ tickers }: PriceCardsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 hide-scrollbar">
      {TRADING_SYMBOLS.map((symbol) => {
        const ticker = tickers.find((t) => t.symbol === symbol)
        const info = SYMBOL_INFO[symbol]
        const positive = (ticker?.changePct24h ?? 0) >= 0

        return (
          <div
            key={symbol}
            className={cn(
              'flex-shrink-0 flex items-center gap-3 px-4 py-3 rounded-xl border transition-all cursor-default',
              'bg-card/60 backdrop-blur-sm',
              positive ? 'border-green-500/20 hover:border-green-500/40' : 'border-red-500/20 hover:border-red-500/40'
            )}
          >
            <div className="flex flex-col items-center justify-center w-8 h-8 rounded-lg bg-secondary/60 text-sm font-bold text-foreground">
              {info.icon}
            </div>
            <div>
              <div className="text-xs text-muted-foreground font-medium">{info.name}</div>
              <div className="text-sm font-bold number-mono text-foreground">
                {ticker ? `$${ticker.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : '—'}
              </div>
            </div>
            <div className={cn('flex items-center gap-0.5 text-xs font-semibold', positive ? 'text-green-400' : 'text-red-400')}>
              {positive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {ticker ? `${positive ? '+' : ''}${ticker.changePct24h.toFixed(2)}%` : '—'}
            </div>
          </div>
        )
      })}
    </div>
  )
}
