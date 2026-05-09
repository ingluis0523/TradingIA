'use client'
import { Badge } from '@/components/ui/badge'
import { formatCurrency, formatPercent, cn, timeAgo } from '@/lib/utils'
import type { Trade, Ticker } from '@/types/trading'
import { SYMBOL_INFO } from '@/types/trading'
import { TrendingUp, TrendingDown, Target, ShieldCheck } from 'lucide-react'

interface ActiveTradesProps {
  trades: Trade[]
  tickers: Ticker[]
}

export function ActiveTrades({ trades, tickers }: ActiveTradesProps) {
  if (trades.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="w-12 h-12 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
          <ShieldCheck className="w-6 h-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">Sin posiciones abiertas</p>
        <p className="text-xs text-muted-foreground mt-1">El bot buscará oportunidades en el próximo tick</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {trades.map((trade) => {
        const ticker = tickers.find((t) => t.symbol === trade.symbol)
        const currentPrice = ticker?.price ?? trade.entryPrice
        const info = SYMBOL_INFO[trade.symbol]
        const direction = trade.side === 'BUY' ? 1 : -1
        const priceDiff = currentPrice - trade.entryPrice
        const unrealizedPnl = priceDiff * direction * trade.quantity
        const unrealizedPnlPct = (priceDiff / trade.entryPrice) * direction * trade.leverage * 100
        const positive = unrealizedPnl >= 0

        const slDistance = Math.abs(currentPrice - trade.stopLoss)
        const tp1Distance = Math.abs(trade.takeProfit1 - currentPrice)
        const slPct = (slDistance / currentPrice) * 100
        const tp1Pct = (tp1Distance / currentPrice) * 100

        return (
          <div
            key={trade.id}
            className={cn(
              'rounded-xl border p-4 transition-all',
              positive ? 'border-green-500/20 bg-green-500/5' : 'border-red-500/20 bg-red-500/5'
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-secondary/80 text-sm font-bold">
                  {info.icon}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{trade.symbol.replace('USDT', '')}/USDT</span>
                    <Badge variant={trade.side === 'BUY' ? 'long' : 'short'}>
                      {trade.side === 'BUY' ? '▲ LONG' : '▼ SHORT'} {trade.leverage}x
                    </Badge>
                    {trade.tp1Hit && <Badge variant="info">TP1 ✓</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Entrada: <span className="number-mono text-foreground">${trade.entryPrice.toLocaleString()}</span>
                    {' '}· {timeAgo(trade.openedAt)} · Qty: {trade.quantity}
                  </div>
                </div>
              </div>

              {/* Live P&L */}
              <div className="text-right">
                <div className={cn('text-lg font-bold number-mono', positive ? 'text-green-400' : 'text-red-400')}>
                  {positive ? '+' : ''}{formatCurrency(unrealizedPnl)}
                </div>
                <div className={cn('text-xs font-semibold', positive ? 'text-green-400' : 'text-red-400')}>
                  {positive ? '+' : ''}{unrealizedPnlPct.toFixed(2)}%
                </div>
              </div>
            </div>

            {/* Progress bars */}
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span className="flex items-center gap-1">
                    <Target className="w-3 h-3 text-green-400" />
                    TP1: ${trade.takeProfit1.toLocaleString()}
                  </span>
                  <span className="text-green-400">+{tp1Pct.toFixed(2)}%</span>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500 rounded-full transition-all"
                    style={{ width: `${Math.min(100, trade.side === 'BUY' ? ((currentPrice - trade.entryPrice) / (trade.takeProfit1 - trade.entryPrice)) * 100 : ((trade.entryPrice - currentPrice) / (trade.entryPrice - trade.takeProfit1)) * 100)}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3 text-red-400" />
                    SL: ${trade.stopLoss.toLocaleString()}
                  </span>
                  <span className="text-red-400">-{slPct.toFixed(2)}%</span>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-red-500/60 rounded-full w-full" />
                </div>
              </div>
            </div>

            {/* Current price */}
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Precio actual:</span>
              <span className={cn('number-mono font-semibold', positive ? 'text-green-400' : 'text-red-400')}>
                {positive ? <TrendingUp className="w-3 h-3 inline mr-0.5" /> : <TrendingDown className="w-3 h-3 inline mr-0.5" />}
                ${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
