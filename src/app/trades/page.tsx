'use client'
import { useEffect, useState, useCallback } from 'react'
import { Navbar } from '@/components/dashboard/Navbar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency, formatPercent, formatTimestamp, cn, timeAgo } from '@/lib/utils'
import { SYMBOL_INFO } from '@/types/trading'
import type { Trade, BotConfig } from '@/types/trading'
import { TrendingUp, TrendingDown, Clock, CheckCircle2, XCircle, Filter } from 'lucide-react'

type FilterStatus = 'all' | 'open' | 'closed'

export default function TradesPage() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [config, setConfig] = useState<BotConfig | null>(null)
  const [filter, setFilter] = useState<FilterStatus>('all')
  const [loading, setLoading] = useState(true)

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/trades?limit=100')
      if (res.ok) setTrades(await res.json())
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchTrades()
    fetch('/api/bot/status').then((r) => r.json()).then((d) => setConfig(d.config))
    const interval = setInterval(fetchTrades, 15000)
    return () => clearInterval(interval)
  }, [fetchTrades])

  const filtered = trades.filter((t) =>
    filter === 'all' ? true : filter === 'open' ? t.status === 'OPEN' : t.status === 'CLOSED'
  )

  const totalPnl = trades.filter((t) => t.status === 'CLOSED').reduce((s, t) => s + (t.pnl || 0), 0)
  const openCount = trades.filter((t) => t.status === 'OPEN').length
  const wins = trades.filter((t) => t.status === 'CLOSED' && (t.pnl || 0) > 0)
  const losses = trades.filter((t) => t.status === 'CLOSED' && (t.pnl || 0) <= 0)

  return (
    <div className="min-h-screen bg-background">
      <Navbar botRunning={config?.isRunning} />

      <main className="max-w-[1400px] mx-auto px-4 py-5 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Historial de Operaciones</h1>
          <span className="text-xs text-muted-foreground">Actualización: 15s</span>
        </div>

        {/* Summary Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Total P&L', value: formatCurrency(totalPnl), positive: totalPnl >= 0 },
            { label: 'Abiertas', value: openCount.toString(), positive: true },
            { label: 'Ganadoras', value: wins.length.toString(), positive: true },
            { label: 'Perdedoras', value: losses.length.toString(), positive: losses.length === 0 },
          ].map((s) => (
            <Card key={s.label} className={cn('border', s.positive ? 'border-green-500/10' : 'border-red-500/10')}>
              <CardContent className="p-4">
                <div className={cn('text-xl font-bold number-mono', s.positive ? 'text-green-400' : 'text-red-400')}>
                  {s.value}
                </div>
                <div className="text-xs text-muted-foreground">{s.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filter */}
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          {(['all', 'open', 'closed'] as FilterStatus[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                filter === f ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
              )}
            >
              {f === 'all' ? `Todas (${trades.length})` : f === 'open' ? `Abiertas (${openCount})` : `Cerradas (${trades.length - openCount})`}
            </button>
          ))}
        </div>

        {/* Trades Table */}
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex justify-center py-12 text-muted-foreground text-sm">Cargando operaciones...</div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center py-12 text-muted-foreground">
                <CheckCircle2 className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm">Sin operaciones {filter !== 'all' ? `(${filter})` : ''}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60">
                      {['Par', 'Dirección', 'Entrada', 'Salida', 'Qty', 'Lev', 'SL', 'TP1', 'P&L', 'P&L%', 'Estado', 'Apertura', 'Duración'].map((h) => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((trade) => {
                      const positive = (trade.pnl || 0) >= 0
                      const info = SYMBOL_INFO[trade.symbol]
                      return (
                        <tr key={trade.id} className="border-b border-border/30 hover:bg-secondary/20 transition-colors">
                          <td className="px-4 py-3 font-medium">
                            <span className="mr-1">{info.icon}</span>
                            {trade.symbol.replace('USDT', '')}/USDT
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={trade.side === 'BUY' ? 'long' : 'short'} className="gap-1">
                              {trade.side === 'BUY' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                              {trade.side === 'BUY' ? 'LONG' : 'SHORT'}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 number-mono text-foreground/90">${trade.entryPrice.toLocaleString()}</td>
                          <td className="px-4 py-3 number-mono text-foreground/90">
                            {trade.exitPrice ? `$${trade.exitPrice.toLocaleString()}` : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-4 py-3 number-mono text-foreground/90">{trade.quantity}</td>
                          <td className="px-4 py-3 number-mono">{trade.leverage}x</td>
                          <td className="px-4 py-3 number-mono text-red-400/80">${trade.stopLoss.toLocaleString()}</td>
                          <td className="px-4 py-3 number-mono text-green-400/80">${trade.takeProfit1.toLocaleString()}</td>
                          <td className={cn('px-4 py-3 number-mono font-semibold', trade.pnl !== undefined ? (positive ? 'text-green-400' : 'text-red-400') : 'text-muted-foreground')}>
                            {trade.pnl !== undefined ? (positive ? '+' : '') + formatCurrency(trade.pnl) : '—'}
                          </td>
                          <td className={cn('px-4 py-3 number-mono font-semibold', trade.pnlPct !== undefined ? (positive ? 'text-green-400' : 'text-red-400') : 'text-muted-foreground')}>
                            {trade.pnlPct !== undefined ? formatPercent(trade.pnlPct) : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={trade.status === 'OPEN' ? 'info' : trade.status === 'CLOSED' ? ((trade.pnl || 0) >= 0 ? 'success' : 'destructive') : 'secondary'}>
                              {trade.status === 'OPEN' ? <Clock className="w-2.5 h-2.5 mr-1" /> : trade.status === 'CLOSED' && (trade.pnl || 0) >= 0 ? <CheckCircle2 className="w-2.5 h-2.5 mr-1" /> : <XCircle className="w-2.5 h-2.5 mr-1" />}
                              {trade.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{timeAgo(trade.openedAt)}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {trade.duration ? `${Math.round(trade.duration / 60000)}m` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
