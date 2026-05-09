'use client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency, formatPercent, cn } from '@/lib/utils'
import type { PerformanceMetrics, AccountInfo } from '@/types/trading'
import { TrendingUp, TrendingDown, Target, Award, AlertTriangle, DollarSign, Percent, Activity } from 'lucide-react'

interface StatsCardsProps {
  metrics: PerformanceMetrics | null
  account: AccountInfo | null
  initialCapital: number
}

export function StatsCards({ metrics, account, initialCapital }: StatsCardsProps) {
  const balance = account?.totalMarginBalance ?? initialCapital
  const unrealizedPnl = account?.totalUnrealizedPnl ?? 0

  const stats = [
    {
      title: 'Balance Total',
      value: formatCurrency(balance + unrealizedPnl),
      sub: `${formatPercent(((balance + unrealizedPnl - initialCapital) / initialCapital) * 100)} vs inicial`,
      icon: DollarSign,
      positive: balance + unrealizedPnl >= initialCapital,
    },
    {
      title: 'P&L Esta Semana',
      value: formatCurrency(metrics?.weeklyPnl ?? 0),
      sub: formatPercent(metrics?.weeklyPnlPct ?? 0),
      icon: metrics?.weeklyPnl && metrics.weeklyPnl >= 0 ? TrendingUp : TrendingDown,
      positive: (metrics?.weeklyPnl ?? 0) >= 0,
    },
    {
      title: 'P&L Hoy',
      value: formatCurrency(metrics?.dailyPnl ?? 0),
      sub: formatPercent(metrics?.dailyPnlPct ?? 0),
      icon: Activity,
      positive: (metrics?.dailyPnl ?? 0) >= 0,
    },
    {
      title: 'Win Rate',
      value: `${(metrics?.winRate ?? 0).toFixed(1)}%`,
      sub: `${metrics?.totalTrades ?? 0} trades totales`,
      icon: Target,
      positive: (metrics?.winRate ?? 0) >= 50,
    },
    {
      title: 'Profit Factor',
      value: (metrics?.profitFactor ?? 0).toFixed(2),
      sub: `Avg Win: ${formatCurrency(metrics?.avgWin ?? 0)}`,
      icon: Award,
      positive: (metrics?.profitFactor ?? 0) >= 1,
    },
    {
      title: 'Max Drawdown',
      value: `${(metrics?.maxDrawdown ?? 0).toFixed(2)}%`,
      sub: `Sharpe: ${(metrics?.sharpeRatio ?? 0).toFixed(2)}`,
      icon: AlertTriangle,
      positive: (metrics?.maxDrawdown ?? 0) <= 10,
    },
    {
      title: 'P&L Total',
      value: formatCurrency(metrics?.totalPnl ?? 0),
      sub: formatPercent(metrics?.totalPnlPct ?? 0),
      icon: Percent,
      positive: (metrics?.totalPnl ?? 0) >= 0,
    },
    {
      title: 'PnL No Realizado',
      value: formatCurrency(unrealizedPnl),
      sub: `${account?.positions?.length ?? 0} posición(es) abiertas`,
      icon: TrendingUp,
      positive: unrealizedPnl >= 0,
    },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {stats.map((stat) => (
        <Card key={stat.title} className={cn(
          'border transition-colors',
          stat.positive ? 'border-green-500/10 hover:border-green-500/20' : 'border-red-500/10 hover:border-red-500/20'
        )}>
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="flex items-center gap-1.5 text-xs">
              <stat.icon className="w-3 h-3" />
              {stat.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className={cn(
              'text-xl font-bold number-mono',
              stat.positive ? 'text-green-400' : 'text-red-400'
            )}>
              {stat.value}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{stat.sub}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
