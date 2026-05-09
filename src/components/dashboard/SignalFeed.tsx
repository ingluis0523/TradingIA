'use client'
import { Badge } from '@/components/ui/badge'
import { cn, timeAgo } from '@/lib/utils'
import type { Signal, BotLog } from '@/types/trading'
import { AlertCircle, CheckCircle2, Info, TrendingDown, TrendingUp, Zap, AlertTriangle } from 'lucide-react'

interface SignalFeedProps {
  signals: Signal[]
  logs: BotLog[]
}

const LOG_ICONS = {
  INFO: Info,
  WARN: AlertTriangle,
  ERROR: AlertCircle,
  SUCCESS: CheckCircle2,
  TRADE: Zap,
}

const LOG_CLASSES = {
  INFO: 'text-blue-400',
  WARN: 'text-yellow-400',
  ERROR: 'text-red-400',
  SUCCESS: 'text-green-400',
  TRADE: 'text-primary',
}

export function SignalFeed({ signals, logs }: SignalFeedProps) {
  return (
    <div className="space-y-1 max-h-[400px] overflow-y-auto pr-1">
      {/* Logs */}
      {logs.slice(0, 30).map((log, i) => {
        const Icon = LOG_ICONS[log.level] || Info
        return (
          <div
            key={log.id || i}
            className="flex items-start gap-2 p-2.5 rounded-lg bg-secondary/20 hover:bg-secondary/40 transition-colors animate-fade-in"
          >
            <Icon className={cn('w-3.5 h-3.5 shrink-0 mt-0.5', LOG_CLASSES[log.level])} />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-foreground/90 leading-snug">{log.message}</p>
              {log.data && Object.keys(log.data).length > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {Object.entries(log.data).map(([k, v]) => `${k}: ${v}`).join(' | ')}
                </p>
              )}
            </div>
            <span className="text-xs text-muted-foreground shrink-0">{timeAgo(log.timestamp)}</span>
          </div>
        )
      })}

      {logs.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          Sin actividad reciente. Inicia el bot para ver logs aquí.
        </div>
      )}
    </div>
  )
}

interface SignalBadgeProps {
  signal: Signal
}

export function SignalBadge({ signal }: SignalBadgeProps) {
  const positive = signal.type === 'LONG'
  return (
    <div className={cn(
      'flex items-center gap-2 p-3 rounded-lg border text-xs animate-slide-in',
      positive ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'
    )}>
      {positive ? <TrendingUp className="w-3.5 h-3.5 text-green-400" /> : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
      <div className="flex-1">
        <span className="font-semibold">{signal.symbol.replace('USDT', '')}</span>
        <span className="text-muted-foreground ml-1">{signal.type}</span>
        <span className="text-muted-foreground ml-2">@ ${signal.price.toLocaleString()}</span>
      </div>
      <div className={cn('font-semibold', positive ? 'text-green-400' : 'text-red-400')}>
        {signal.strength}%
      </div>
      <span className="text-muted-foreground">{timeAgo(signal.timestamp)}</span>
    </div>
  )
}
