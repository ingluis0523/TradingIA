'use client'
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Play, Square, RefreshCw, Zap, Cpu, CheckCircle2, AlertCircle } from 'lucide-react'
import type { BotConfig } from '@/types/trading'

interface BotControlsProps {
  config: BotConfig | null
  onStatusChange: () => void
  onOptimisticChange?: (running: boolean) => void
}

interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
}

export function BotControls({ config, onStatusChange, onOptimisticChange }: BotControlsProps) {
  // Estado local optimista — se actualiza inmediatamente al hacer clic
  const [localRunning, setLocalRunning] = useState<boolean>(config?.isRunning ?? false)
  const [loading, setLoading] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [toastId, setToastId] = useState(0)

  // Sincroniza cuando el config del padre llega actualizado
  useEffect(() => {
    if (config !== null) {
      setLocalRunning(config.isRunning)
    }
  }, [config?.isRunning])

  const addToast = (message: string, type: Toast['type']) => {
    const id = toastId + 1
    setToastId(id)
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000)
  }

  const call = async (action: string) => {
    setLoading(action)

    // Optimistic UI: actualiza el estado visualmente de inmediato (local + Navbar)
    if (action === 'start') { setLocalRunning(true); onOptimisticChange?.(true) }
    if (action === 'stop') { setLocalRunning(false); onOptimisticChange?.(false) }

    try {
      const url = action === 'tick' ? '/api/bot/tick' : `/api/bot/${action}`
      const res = await fetch(url, { method: 'POST' })
      const data = await res.json()

      if (data.success === false) {
        // Si el error es "ya está corriendo", es informativo no un fallo real
        if (action === 'start' && data.message?.includes('ya está corriendo')) {
          setLocalRunning(true)
          addToast('✅ Bot ya estaba corriendo', 'info')
        } else if (action === 'stop' && data.message?.includes('detenido')) {
          setLocalRunning(false)
          addToast('⏹️ Bot detenido', 'success')
        } else {
          // Revert optimistic update on real errors
          if (action === 'start') { setLocalRunning(false); onOptimisticChange?.(false) }
          if (action === 'stop') { setLocalRunning(true); onOptimisticChange?.(true) }
          addToast(`Error: ${data.message}`, 'error')
        }
      } else {
        if (action === 'start') addToast('🚀 Bot iniciado correctamente', 'success')
        if (action === 'stop') addToast('⏹️ Bot detenido', 'success')
        if (action === 'tick') {
          const msg = data.tradesOpened > 0
            ? `✅ Tick: ${data.tradesOpened} trade(s) abierto(s), ${data.signalsGenerated} señal(es)`
            : data.signalsGenerated > 0
              ? `📊 Tick: ${data.signalsGenerated} señal(es) analizadas, sin entrada`
              : `🔍 Tick completado — sin señales en este momento`
          addToast(msg, 'success')
        }
      }

      // Sync con el servidor después de un delay
      setTimeout(() => onStatusChange(), 800)
    } catch (e) {
      if (action === 'start') { setLocalRunning(false); onOptimisticChange?.(false) }
      if (action === 'stop') { setLocalRunning(true); onOptimisticChange?.(true) }
      addToast(`Error de red: ${e instanceof Error ? e.message : 'desconocido'}`, 'error')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap gap-y-2">
        {/* Status badge */}
        <div className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium',
          localRunning
            ? 'bg-green-500/10 border-green-500/30 text-green-400'
            : 'bg-gray-500/10 border-gray-500/30 text-gray-400'
        )}>
          <Cpu className="w-3.5 h-3.5" />
          <div className={cn('w-2 h-2 rounded-full', localRunning ? 'bg-green-400 animate-pulse' : 'bg-gray-500')} />
          {localRunning ? 'Bot Activo' : 'Bot Inactivo'}
        </div>

        {!localRunning ? (
          <Button
            variant="success"
            size="sm"
            loading={loading === 'start'}
            onClick={() => call('start')}
          >
            <Play className="w-3.5 h-3.5" />
            Iniciar Bot
          </Button>
        ) : (
          <Button
            variant="destructive"
            size="sm"
            loading={loading === 'stop'}
            onClick={() => call('stop')}
          >
            <Square className="w-3.5 h-3.5" />
            Detener Bot
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          loading={loading === 'tick'}
          onClick={() => call('tick')}
          title="Ejecutar análisis manual ahora"
        >
          <Zap className="w-3.5 h-3.5" />
          Tick Manual
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => onStatusChange()}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Actualizar
        </Button>

        {config && (
          <div className="flex items-center gap-2 md:gap-3 ml-auto text-xs text-muted-foreground flex-wrap justify-end">
            <span>Lev: <strong className="text-foreground">{config.leverage}x</strong></span>
            <span className="hidden sm:inline">Riesgo: <strong className="text-foreground">{(config.riskPerTrade * 100).toFixed(0)}%</strong></span>
            <span className="hidden sm:inline">Pos: <strong className="text-foreground">{config.maxPositions}</strong></span>
            <span>Capital: <strong className="text-foreground">${config.currentCapital?.toFixed(0)}</strong></span>
          </div>
        )}
      </div>

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="flex flex-col gap-1">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium animate-fade-in',
                t.type === 'success' && 'bg-green-500/10 border border-green-500/20 text-green-300',
                t.type === 'error' && 'bg-red-500/10 border border-red-500/20 text-red-300',
                t.type === 'info' && 'bg-blue-500/10 border border-blue-500/20 text-blue-300',
              )}
            >
              {t.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
              {t.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
