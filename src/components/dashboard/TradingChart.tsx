'use client'
import { useEffect, useRef, useState } from 'react'
import { createChart, ColorType } from 'lightweight-charts'
import { TRADING_SYMBOLS } from '@/types/trading'
import type { TradingSymbol } from '@/types/trading'
import { cn } from '@/lib/utils'

interface TradingChartProps {
  className?: string
}

const INTERVALS = ['5m', '15m', '1h', '4h', '1d']

export function TradingChart({ className }: TradingChartProps) {
  const chartRef = useRef<HTMLDivElement>(null)
  const [symbol, setSymbol] = useState<TradingSymbol>('BTCUSDT')
  const [interval, setInterval] = useState('4h')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!chartRef.current) return

    const chart = createChart(chartRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: 'rgba(148,163,184,0.05)' },
        horzLines: { color: 'rgba(148,163,184,0.05)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(148,163,184,0.3)', labelBackgroundColor: '#1e293b' },
        horzLine: { color: 'rgba(148,163,184,0.3)', labelBackgroundColor: '#1e293b' },
      },
      rightPriceScale: {
        borderColor: 'rgba(148,163,184,0.1)',
        textColor: '#94a3b8',
      },
      timeScale: {
        borderColor: 'rgba(148,163,184,0.1)',
        timeVisible: true,
      },
      width: chartRef.current.clientWidth,
      height: 320,
    })

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    })

    const ema10Series = chart.addLineSeries({
      color: '#3b82f6',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    })

    const ema55Series = chart.addLineSeries({
      color: '#f59e0b',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    })

    const loadData = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/prices/chart?symbol=${symbol}&interval=${interval}&limit=200`)
        const candles = await res.json()

        if (!Array.isArray(candles)) return

        const candleData = candles.map((c: { openTime: number; open: number; high: number; low: number; close: number }) => ({
          time: Math.floor(c.openTime / 1000) as unknown as import('lightweight-charts').UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))

        candleSeries.setData(candleData)

        const closes = candles.map((c: { close: number }) => c.close)

        const calcEma = (period: number) => {
          const k = 2 / (period + 1)
          const result: { time: import('lightweight-charts').UTCTimestamp; value: number }[] = []
          let prev = closes.slice(0, period).reduce((s: number, v: number) => s + v, 0) / period
          candles.slice(period - 1).forEach((c: { openTime: number; close: number }, i: number) => {
            if (i === 0) {
              result.push({ time: Math.floor(c.openTime / 1000) as unknown as import('lightweight-charts').UTCTimestamp, value: prev })
              return
            }
            prev = closes[period - 1 + i] * k + prev * (1 - k)
            result.push({ time: Math.floor(c.openTime / 1000) as unknown as import('lightweight-charts').UTCTimestamp, value: prev })
          })
          return result
        }

        ema10Series.setData(calcEma(10))
        ema55Series.setData(calcEma(55))
        chart.timeScale().fitContent()
      } catch (e) {
        console.error('Chart load error:', e)
      } finally {
        setLoading(false)
      }
    }

    loadData()

    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth })
    })
    resizeObserver.observe(chartRef.current)

    return () => {
      chart.remove()
      resizeObserver.disconnect()
    }
  }, [symbol, interval])

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1">
          {TRADING_SYMBOLS.map((s) => (
            <button
              key={s}
              onClick={() => setSymbol(s)}
              className={cn(
                'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                symbol === s ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
              )}
            >
              {s.replace('USDT', '')}
            </button>
          ))}
        </div>
        <div className="flex gap-1 ml-auto">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              className={cn(
                'px-2 py-1 rounded text-xs transition-colors',
                interval === iv ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {iv}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-background/50 rounded-xl">
            <div className="text-xs text-muted-foreground">Cargando...</div>
          </div>
        )}
        <div ref={chartRef} className="w-full rounded-xl overflow-hidden" />
      </div>

      <div className="flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-0.5 bg-blue-500 inline-block" />EMA 10
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-0.5 bg-yellow-500 inline-block" />EMA 55
        </span>
        <span className="ml-auto text-muted-foreground/60">Fuente: Binance Futures</span>
      </div>
    </div>
  )
}
