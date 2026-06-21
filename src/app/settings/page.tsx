'use client'
import { useEffect, useState } from 'react'
import { Navbar } from '@/components/dashboard/Navbar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { BotConfig } from '@/types/trading'
import { TRADING_SYMBOLS, getSymbolInfo } from '@/types/trading'
import { Save, AlertTriangle, Info, ExternalLink, ShieldCheck, Cpu } from 'lucide-react'

export default function SettingsPage() {
  const [config, setConfig] = useState<Partial<BotConfig>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/bot/config').then((r) => r.json()).then((c) => {
      if (c) setConfig(c)
      else setConfig({
        symbols: TRADING_SYMBOLS,
        leverage: 3,
        riskPerTrade: 0.02,
        maxPositions: 3,
        maxDailyLoss: 0.05,
        initialCapital: 1000,
        marginType: 'ISOLATED',
      })
    })
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await fetch('/api/bot/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  const toggleSymbol = (sym: typeof TRADING_SYMBOLS[0]) => {
    const current = config.symbols || []
    setConfig({
      ...config,
      symbols: current.includes(sym) ? current.filter((s) => s !== sym) : [...current, sym],
    })
  }

  return (
    <div className="min-h-screen bg-background">
      <Navbar botRunning={config?.isRunning} />

      <main className="max-w-[800px] mx-auto px-4 py-5 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Configuración del Bot</h1>
          <Button onClick={save} loading={saving} variant={saved ? 'success' : 'default'} size="sm">
            <Save className="w-3.5 h-3.5" />
            {saved ? 'Guardado!' : 'Guardar Cambios'}
          </Button>
        </div>

        {/* API Config Notice */}
        <Card className="border-blue-500/20 bg-blue-500/5">
          <CardContent className="p-4 flex gap-3">
            <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div className="text-xs text-blue-300/90 space-y-1">
              <p className="font-semibold">Configuración de API Keys</p>
              <p>Las API keys se configuran en el archivo <code className="bg-blue-500/20 px-1 rounded">.env.local</code> por razones de seguridad. No se exponen en el dashboard.</p>
              <div className="flex gap-3 mt-2">
                <a
                  href="https://testnet.binancefuture.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-blue-400 hover:text-blue-300"
                >
                  <ExternalLink className="w-3 h-3" />
                  Binance Testnet (obtener API keys)
                </a>
                <a
                  href="https://app.supabase.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-blue-400 hover:text-blue-300"
                >
                  <ExternalLink className="w-3 h-3" />
                  Supabase (base de datos)
                </a>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Trading Pairs */}
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Cpu className="w-3.5 h-3.5" />Pares de Trading</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">Selecciona los pares que el bot monitorizará y en los que podrá operar.</p>
            <div className="flex flex-wrap gap-2">
              {TRADING_SYMBOLS.map((sym) => {
                const info = getSymbolInfo(sym)
                const active = (config.symbols || []).includes(sym)
                return (
                  <button
                    key={sym}
                    onClick={() => toggleSymbol(sym)}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition-all',
                      active
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border/60 bg-secondary/20 text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <span>{info.icon}</span>
                    {info.name}
                    <span className="text-xs opacity-60">{sym.replace('USDT', '')}/USDT</span>
                  </button>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Risk Management */}
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="w-3.5 h-3.5" />Gestión de Riesgo</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Setting
                label="Capital Inicial (USDT)"
                hint="Capital base para calcular el tamaño de posiciones"
                value={config.initialCapital?.toString() || '1000'}
                onChange={(v) => setConfig({ ...config, initialCapital: Number(v) })}
                type="number"
              />
              <Setting
                label="Riesgo por Trade (%)"
                hint="% del capital que arriesgas por operación. Recomendado: 1-2%"
                value={((config.riskPerTrade || 0.02) * 100).toString()}
                onChange={(v) => setConfig({ ...config, riskPerTrade: Number(v) / 100 })}
                type="number"
                step="0.5"
              />
              <Setting
                label="Apalancamiento (x)"
                hint="Multiplicador de posición. Mayor = más riesgo. Recomendado: 3x"
                value={config.leverage?.toString() || '3'}
                onChange={(v) => setConfig({ ...config, leverage: Number(v) })}
                type="number"
                min="1"
                max="10"
              />
              <Setting
                label="Máx. Posiciones Simultáneas"
                hint="Número máximo de trades abiertos al mismo tiempo"
                value={config.maxPositions?.toString() || '3'}
                onChange={(v) => setConfig({ ...config, maxPositions: Number(v) })}
                type="number"
                min="1"
                max="5"
              />
              <Setting
                label="Pérdida Diaria Máxima (%)"
                hint="Si se alcanza, el bot para de operar por el día. Recomendado: 5%"
                value={((config.maxDailyLoss || 0.05) * 100).toString()}
                onChange={(v) => setConfig({ ...config, maxDailyLoss: Number(v) / 100 })}
                type="number"
                step="0.5"
              />
              <div>
                <label className="text-xs font-medium text-muted-foreground">Tipo de Margen</label>
                <div className="flex gap-2 mt-1.5">
                  {['ISOLATED', 'CROSSED'].map((mt) => (
                    <button
                      key={mt}
                      onClick={() => setConfig({ ...config, marginType: mt as BotConfig['marginType'] })}
                      className={cn(
                        'flex-1 py-2 rounded-lg border text-xs font-medium transition-colors',
                        config.marginType === mt ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border/60 text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {mt}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">ISOLATED limita el riesgo por trade. Recomendado para empezar.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Strategy Info */}
        <Card className="border-green-500/10">
          <CardHeader><CardTitle>Estrategia: AMSS (Adaptive Multi-Signal Strategy)</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-xs text-muted-foreground">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="font-semibold text-foreground mb-1">Indicadores utilizados:</p>
                <ul className="space-y-1">
                  <li>• <strong className="text-blue-400">EMA 20/50/200</strong> — Dirección de tendencia (1H y 4H)</li>
                  <li>• <strong className="text-yellow-400">RSI (14)</strong> — Momentum y zonas extremas</li>
                  <li>• <strong className="text-purple-400">MACD (12/26/9)</strong> — Cruce de momentum para entrada</li>
                  <li>• <strong className="text-green-400">ATR (14)</strong> — Tamaño dinámico de SL/TP</li>
                  <li>• <strong className="text-orange-400">SuperTrend (7, 3x)</strong> — Filtro de tendencia</li>
                  <li>• <strong className="text-pink-400">ADX (14)</strong> — Fuerza de la tendencia (&gt;20)</li>
                  <li>• <strong className="text-cyan-400">Volume MA (20)</strong> — Confirmación de volumen</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-foreground mb-1">Reglas de entrada:</p>
                <ul className="space-y-1">
                  <li>• 4H: EMA20 &gt; EMA50 y precio &gt; EMA200 (LONG)</li>
                  <li>• 1H: Cruce alcista del histograma MACD</li>
                  <li>• 1H: RSI entre 35-68 (sin zona extrema)</li>
                  <li>• 1H: SuperTrend en dirección UP</li>
                  <li>• Volumen &gt; 110% de la media (confirmación)</li>
                  <li>• ADX &gt; 20 (tendencia válida)</li>
                </ul>
                <p className="font-semibold text-foreground mt-3 mb-1">Exits dinámicos:</p>
                <ul className="space-y-1">
                  <li>• SL: 1.5x ATR desde la entrada</li>
                  <li>• TP1: 2.5x ATR (50% del trade)</li>
                  <li>• TP2: 4.0x ATR (50% restante)</li>
                  <li>• Trailing stop tras TP1</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Risk Warning */}
        <Card className="border-yellow-500/20 bg-yellow-500/5">
          <CardContent className="p-4 flex gap-3">
            <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
            <div className="text-xs text-yellow-300/80 space-y-1">
              <p className="font-semibold text-yellow-400">Aviso de Riesgo</p>
              <p>El trading de criptomonedas con futuros y apalancamiento conlleva un alto riesgo de pérdida. Este sistema está actualmente en <strong>modo testnet</strong> con dinero virtual. Antes de pasar a trading real, valida el rendimiento durante al menos 4 semanas en testnet.</p>
              <p>El objetivo de 5% semanal es ambicioso — el rendimiento real puede variar significativamente según las condiciones del mercado.</p>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

function Setting({ label, hint, value, onChange, type = 'text', min, max, step }: {
  label: string; hint?: string; value: string; onChange: (v: string) => void
  type?: string; min?: string; max?: string; step?: string
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Input
        type={type}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5"
      />
      {hint && <p className="text-xs text-muted-foreground mt-1 opacity-70">{hint}</p>}
    </div>
  )
}
