'use client'
import { useEffect, useState } from 'react'
import { Navbar } from '@/components/dashboard/Navbar'
import { PerformanceChart } from '@/components/dashboard/PerformanceChart'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency, formatPercent, cn } from '@/lib/utils'
import type { Trade, PerformanceMetrics, BotConfig } from '@/types/trading'
import { TRADING_SYMBOLS, SYMBOL_INFO } from '@/types/trading'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts'

export default function AnalyticsPage() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null)
  const [config, setConfig] = useState<BotConfig | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/trades?limit=200').then((r) => r.json()),
      fetch('/api/bot/status').then((r) => r.json()),
    ]).then(([t, s]) => {
      setTrades(t)
      setMetrics(s.metrics)
      setConfig(s.config)
    })
  }, [])

  const closedTrades = trades.filter((t) => t.status === 'CLOSED')

  // By symbol stats
  const symbolStats = TRADING_SYMBOLS.map((sym) => {
    const symTrades = closedTrades.filter((t) => t.symbol === sym)
    const wins = symTrades.filter((t) => (t.pnl || 0) > 0)
    const pnl = symTrades.reduce((s, t) => s + (t.pnl || 0), 0)
    return {
      symbol: sym.replace('USDT', ''),
      trades: symTrades.length,
      wins: wins.length,
      pnl,
      winRate: symTrades.length ? (wins.length / symTrades.length) * 100 : 0,
    }
  }).filter((s) => s.trades > 0)

  // Weekly PnL chart (last 8 weeks)
  const weeklyData: { week: string; pnl: number }[] = []
  const now = new Date()
  for (let i = 7; i >= 0; i--) {
    const weekEnd = new Date(now)
    weekEnd.setDate(weekEnd.getDate() - i * 7)
    const weekStart = new Date(weekEnd)
    weekStart.setDate(weekStart.getDate() - 7)
    const weekTrades = closedTrades.filter((t) => {
      const d = new Date(t.closedAt || t.openedAt)
      return d >= weekStart && d < weekEnd
    })
    const pnl = weekTrades.reduce((s, t) => s + (t.pnl || 0), 0)
    weeklyData.push({
      week: `S${8 - i}`,
      pnl: Math.round(pnl * 100) / 100,
    })
  }

  // Distribution by P&L ranges
  const distribution = [
    { range: '<-5%', count: 0, color: '#ef4444' },
    { range: '-5~-2%', count: 0, color: '#f97316' },
    { range: '-2~0%', count: 0, color: '#fb923c' },
    { range: '0~2%', count: 0, color: '#86efac' },
    { range: '2~5%', count: 0, color: '#4ade80' },
    { range: '>5%', count: 0, color: '#22c55e' },
  ]
  closedTrades.forEach((t) => {
    const p = t.pnlPct || 0
    if (p < -5) distribution[0].count++
    else if (p < -2) distribution[1].count++
    else if (p < 0) distribution[2].count++
    else if (p < 2) distribution[3].count++
    else if (p < 5) distribution[4].count++
    else distribution[5].count++
  })

  const pieData = [
    { name: 'Ganadoras', value: closedTrades.filter((t) => (t.pnl || 0) > 0).length, color: '#22c55e' },
    { name: 'Perdedoras', value: closedTrades.filter((t) => (t.pnl || 0) <= 0).length, color: '#ef4444' },
  ]

  return (
    <div className="min-h-screen bg-background">
      <Navbar botRunning={config?.isRunning} />

      <main className="max-w-[1400px] mx-auto px-4 py-5 space-y-4">
        <h1 className="text-xl font-bold">Analytics de Rendimiento</h1>

        {/* Key Metrics */}
        {metrics && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Win Rate', value: `${metrics.winRate.toFixed(1)}%`, positive: metrics.winRate >= 50 },
              { label: 'Profit Factor', value: metrics.profitFactor.toFixed(2), positive: metrics.profitFactor >= 1 },
              { label: 'Sharpe Ratio', value: metrics.sharpeRatio.toFixed(2), positive: metrics.sharpeRatio >= 1 },
              { label: 'Max Drawdown', value: `${metrics.maxDrawdown.toFixed(2)}%`, positive: metrics.maxDrawdown <= 10 },
              { label: 'P&L Total', value: formatCurrency(metrics.totalPnl), positive: metrics.totalPnl >= 0 },
              { label: 'P&L Semanal', value: formatCurrency(metrics.weeklyPnl), positive: metrics.weeklyPnl >= 0 },
              { label: 'Avg Win', value: formatCurrency(metrics.avgWin), positive: true },
              { label: 'Avg Loss', value: `-${formatCurrency(metrics.avgLoss)}`, positive: false },
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
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Capital Curve */}
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Curva de Capital</CardTitle></CardHeader>
            <CardContent>
              <PerformanceChart
                trades={trades}
                initialCapital={config?.initialCapital || 1000}
              />
            </CardContent>
          </Card>

          {/* Win/Loss Pie */}
          <Card>
            <CardHeader><CardTitle>Win / Loss Ratio</CardTitle></CardHeader>
            <CardContent className="flex flex-col items-center">
              {closedTrades.length > 0 ? (
                <PieChart width={220} height={200}>
                  <Pie data={pieData} cx={110} cy={100} innerRadius={55} outerRadius={85} paddingAngle={3} dataKey="value">
                    {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px', fontSize: '12px' }} />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                </PieChart>
              ) : (
                <div className="h-48 flex items-center text-sm text-muted-foreground">Sin datos</div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Weekly PnL Bar Chart */}
          <Card>
            <CardHeader><CardTitle>P&L Semanal</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={weeklyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.05)" />
                  <XAxis dataKey="week" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px', fontSize: '12px' }}
                    formatter={(v: number) => [formatCurrency(v), 'P&L']}
                  />
                  <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                    {weeklyData.map((entry, i) => (
                      <Cell key={i} fill={entry.pnl >= 0 ? '#22c55e' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* P&L Distribution */}
          <Card>
            <CardHeader><CardTitle>Distribución de Trades</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={distribution.filter((d) => d.count > 0)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.05)" />
                  <XAxis dataKey="range" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px', fontSize: '12px' }} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {distribution.filter((d) => d.count > 0).map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        {/* By Symbol */}
        {symbolStats.length > 0 && (
          <Card>
            <CardHeader><CardTitle>Rendimiento por Par</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                {symbolStats.map((s) => (
                  <div key={s.symbol} className={cn(
                    'p-4 rounded-xl border text-center',
                    s.pnl >= 0 ? 'border-green-500/20 bg-green-500/5' : 'border-red-500/20 bg-red-500/5'
                  )}>
                    <div className="text-2xl mb-1">{SYMBOL_INFO[`${s.symbol}USDT` as keyof typeof SYMBOL_INFO]?.icon}</div>
                    <div className="text-sm font-semibold">{s.symbol}/USDT</div>
                    <div className={cn('text-base font-bold number-mono mt-1', s.pnl >= 0 ? 'text-green-400' : 'text-red-400')}>
                      {s.pnl >= 0 ? '+' : ''}{formatCurrency(s.pnl)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {s.trades} trades · {s.winRate.toFixed(0)}% WR
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  )
}
