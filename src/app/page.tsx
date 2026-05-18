'use client'
import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import { Navbar } from '@/components/dashboard/Navbar'
import { StatsCards } from '@/components/dashboard/StatsCards'
import { PriceCards } from '@/components/dashboard/PriceCards'
import { BotControls } from '@/components/dashboard/BotControls'
import { ActiveTrades } from '@/components/dashboard/ActiveTrades'
import { SignalFeed } from '@/components/dashboard/SignalFeed'
import { TradingChart } from '@/components/dashboard/TradingChart'
import { PerformanceChart } from '@/components/dashboard/PerformanceChart'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { BotConfig, PerformanceMetrics, AccountInfo, Trade, Signal, BotLog, Ticker } from '@/types/trading'

// Browser-only Supabase client (anon key, used only for Realtime subscription)
const supabaseBrowser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface DashboardData {
  config: BotConfig | null
  openTrades: Trade[]
  logs: BotLog[]
  metrics: PerformanceMetrics | null
  account: AccountInfo | null
}

const INITIAL_CONFIG: BotConfig = {
  isRunning: false,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
  leverage: 3,
  riskPerTrade: 0.02,
  maxPositions: 3,
  maxDailyLoss: 0.05,
  initialCapital: 1000,
  currentCapital: 1000,
  marginType: 'ISOLATED',
  strategy: 'AMSS',
  timeframe: '1h',
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData>({
    config: null,
    openTrades: [],
    logs: [],
    metrics: null,
    account: null,
  })
  const [tickers, setTickers] = useState<Ticker[]>([])
  const [recentTrades, setRecentTrades] = useState<Trade[]>([])
  const [signals, setSignals] = useState<Signal[]>([])
  const [logs, setLogs] = useState<BotLog[]>([])
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [mounted, setMounted] = useState(false)
  const [apiErrors, setApiErrors] = useState<string[]>([])
  const [botRunning, setBotRunning] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bot/status')
      if (res.ok) {
        const json: DashboardData & { errors?: string[] } = await res.json()
        setData(json)
        setLastUpdate(new Date())
        setApiErrors(json.errors || [])
        if (json.config) setBotRunning(json.config.isRunning)
      }
    } catch {}
  }, [])

  const fetchPrices = useCallback(async () => {
    try {
      const res = await fetch('/api/prices')
      if (res.ok) setTickers(await res.json())
    } catch {}
  }, [])

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/trades?limit=20')
      if (res.ok) setRecentTrades(await res.json())
    } catch {}
  }, [])

  const fetchSignals = useCallback(async () => {
    try {
      const res = await fetch('/api/signals?limit=20')
      if (res.ok) setSignals(await res.json())
    } catch {}
  }, [])

  const fetchLogs = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from('bot_logs')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(30)
    if (data) setLogs(data as BotLog[])
  }, [])

  // Main data intervals
  useEffect(() => {
    setMounted(true)
    fetchStatus()
    fetchPrices()
    fetchTrades()
    fetchSignals()
    fetchLogs() // Initial load of existing logs

    const priceInterval = setInterval(fetchPrices, 5000)
    const statusInterval = setInterval(fetchStatus, 15000)
    const tradesInterval = setInterval(() => { fetchTrades(); fetchSignals() }, 20000)
    // Fallback poll for logs every 60s (Realtime handles real-time updates)
    const logsInterval = setInterval(fetchLogs, 60000)

    return () => {
      clearInterval(priceInterval)
      clearInterval(statusInterval)
      clearInterval(tradesInterval)
      clearInterval(logsInterval)
    }
  }, [fetchStatus, fetchPrices, fetchTrades, fetchSignals, fetchLogs])

  // Supabase Realtime: receive new log rows the instant they're inserted
  useEffect(() => {
    const channel = supabaseBrowser
      .channel('bot-logs-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'bot_logs' },
        (payload) => {
          const newLog = payload.new as BotLog
          setLogs((prev) => [newLog, ...prev].slice(0, 30))
        }
      )
      .subscribe()

    return () => {
      supabaseBrowser.removeChannel(channel)
    }
  }, [])

  // Supabase Realtime: refresh active trades instantly on any trade change
  useEffect(() => {
    const channel = supabaseBrowser
      .channel('trades-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trades' },
        () => { fetchStatus() }
      )
      .subscribe()

    return () => {
      supabaseBrowser.removeChannel(channel)
    }
  }, [fetchStatus])

  const config = data.config || INITIAL_CONFIG

  return (
    <div className="min-h-screen bg-background">
      <Navbar botRunning={botRunning} />

      <main className="max-w-[1600px] mx-auto px-3 sm:px-4 py-4 space-y-3 sm:space-y-4">
        {/* Price Ticker Bar */}
        <PriceCards tickers={tickers} />

        {/* Bot Controls */}
        <div className="card-glass p-4">
          <BotControls
            config={config}
            onOptimisticChange={setBotRunning}
            onStatusChange={() => {
              setTimeout(() => { fetchStatus(); fetchTrades() }, 600)
            }}
          />
        </div>

        {/* Connection errors banner */}
        {apiErrors.length > 0 && (
          <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-3">
            <p className="text-xs font-semibold text-yellow-400 mb-1">⚠️ Errores de conexión — revisa tu .env.local</p>
            {apiErrors.map((e, i) => (
              <p key={i} className="text-xs text-yellow-300/70 font-mono">{e}</p>
            ))}
          </div>
        )}

        {/* Stats */}
        <StatsCards
          metrics={data.metrics}
          account={data.account}
          initialCapital={config.initialCapital}
        />

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Chart - 2/3 width */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Gráfico de Precios — Testnet Binance</CardTitle>
              </CardHeader>
              <CardContent>
                <TradingChart />
              </CardContent>
            </Card>
          </div>

          {/* Active Trades - 1/3 width */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Posiciones Activas</CardTitle>
                <span className="text-xs text-muted-foreground">
                  {data.openTrades.length}/{config.maxPositions}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <ActiveTrades trades={data.openTrades} tickers={tickers} />
            </CardContent>
          </Card>
        </div>

        {/* Bottom Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Performance Chart */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Curva de Capital</CardTitle>
                <span className="text-xs text-muted-foreground">
                  Inicial: ${config.initialCapital.toLocaleString()}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <PerformanceChart
                trades={recentTrades}
                initialCapital={config.initialCapital}
              />
            </CardContent>
          </Card>

          {/* Log Feed */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Log del Bot</CardTitle>
                <span className="text-xs text-muted-foreground" suppressHydrationWarning>
                  {mounted && lastUpdate ? `Actualizado: ${lastUpdate.toLocaleTimeString('es-ES')}` : 'Cargando...'}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <SignalFeed signals={signals} logs={logs} />
            </CardContent>
          </Card>
        </div>

        {/* Quick Stats Row */}
        {data.metrics && (
          <div className="card-glass p-3 sm:p-4">
            <div className="grid grid-cols-3 md:grid-cols-6 gap-3 sm:gap-4 text-center">
              {[
                { label: 'Mejor trade', value: `+$${data.metrics.bestTrade.toFixed(2)}`, color: 'text-green-400' },
                { label: 'Peor trade', value: `$${data.metrics.worstTrade.toFixed(2)}`, color: 'text-red-400' },
                { label: 'Win seguidos', value: data.metrics.consecutiveWins.toString(), color: 'text-green-400' },
                { label: 'Loss seguidos', value: data.metrics.consecutiveLosses.toString(), color: 'text-red-400' },
                { label: 'Avg Win', value: `$${data.metrics.avgWin.toFixed(2)}`, color: 'text-green-400' },
                { label: 'Avg Loss', value: `$${data.metrics.avgLoss.toFixed(2)}`, color: 'text-red-400' },
              ].map((item) => (
                <div key={item.label}>
                  <div className={`text-base font-bold number-mono ${item.color}`}>{item.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{item.label}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
