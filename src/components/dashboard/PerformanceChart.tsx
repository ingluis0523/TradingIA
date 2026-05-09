'use client'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import type { Trade } from '@/types/trading'
import { formatCurrency } from '@/lib/utils'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

interface PerformanceChartProps {
  trades: Trade[]
  initialCapital: number
}

export function PerformanceChart({ trades, initialCapital }: PerformanceChartProps) {
  const closedTrades = [...trades]
    .filter((t) => t.status === 'CLOSED')
    .sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime())

  let capital = initialCapital
  const data = [{ date: 'Inicio', capital, pnl: 0 }]

  closedTrades.forEach((trade) => {
    capital += trade.pnl || 0
    data.push({
      date: format(new Date(trade.closedAt || trade.openedAt), 'd MMM', { locale: es }),
      capital: Math.round(capital * 100) / 100,
      pnl: Math.round((trade.pnl || 0) * 100) / 100,
    })
  })

  const maxCapital = Math.max(...data.map((d) => d.capital))
  const minCapital = Math.min(...data.map((d) => d.capital))
  const isProfit = capital >= initialCapital

  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
        Sin operaciones cerradas aún
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <defs>
          <linearGradient id="capitalGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={isProfit ? '#22c55e' : '#ef4444'} stopOpacity={0.2} />
            <stop offset="95%" stopColor={isProfit ? '#22c55e' : '#ef4444'} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.05)" />
        <XAxis
          dataKey="date"
          tick={{ fill: '#64748b', fontSize: 11 }}
          axisLine={{ stroke: 'rgba(148,163,184,0.1)' }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: '#64748b', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => `$${v.toFixed(0)}`}
          domain={[minCapital * 0.99, maxCapital * 1.01]}
          width={65}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#0f172a',
            border: '1px solid rgba(148,163,184,0.2)',
            borderRadius: '8px',
            fontSize: '12px',
          }}
          labelStyle={{ color: '#94a3b8' }}
          formatter={(value: number, name: string) => [
            name === 'capital' ? formatCurrency(value) : (value >= 0 ? '+' : '') + formatCurrency(value),
            name === 'capital' ? 'Capital' : 'P&L Trade',
          ]}
        />
        <Area
          type="monotone"
          dataKey="capital"
          stroke={isProfit ? '#22c55e' : '#ef4444'}
          strokeWidth={2}
          fill="url(#capitalGradient)"
          dot={false}
          activeDot={{ r: 4, fill: isProfit ? '#22c55e' : '#ef4444' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
