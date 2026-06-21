# Parche de Observabilidad — Logging Diagnóstico de Señales

> **Objetivo**: instrumentar `signals.ts` y `regime.ts` con logging suficiente para diagnosticar por qué el bot no genera señales, sin cambiar nada del comportamiento de trading.

**Audiencia**: Claude Code
**Pre-requisito**: Fase 1.5 aplicada (régimen + signals.ts actual).
**Tiempo estimado**: 30-45 min.
**Estado al terminar**: cada tick deja en `bot_logs` una traza estructurada por símbolo de qué pasó: régimen detectado, filtros pasados/fallados, decisión final.

---

## 1. Diagnóstico actual

En 333 ticks consecutivos (11h) tenemos exactamente 3 tipos de log y 0 señales. No hay forma de saber por qué. El campo `data jsonb` de `bot_logs` existe en el schema pero nunca se usa. Lo vamos a aprovechar.

---

## 2. Cambios

### 2.1 Helper de logging estructurado

Crear `src/lib/strategy/signal-trace.ts`:

```typescript
import { addLogForUser } from '@/lib/supabase'
import type { RegimeAnalysis } from './regime'
import type { Indicators, TradingSymbol } from '@/types/trading'

export interface SignalTrace {
  symbol: TradingSymbol
  price: number
  regime: {
    name: string
    adx: number
    diPlus: number
    diMinus: number
    slope: number
    allowLong: boolean
    allowShort: boolean
  }
  filters1h?: {
    macdBullish: boolean
    macdBearish: boolean
    macdHist: number
    macdHistPrev: number
    rsiLong: boolean
    rsiShort: boolean
    rsi14: number
    stBullish: boolean
    stBearish: boolean
    stDirection: 'UP' | 'DOWN'
    volumeConfirmed: boolean
    volumeRatio: number  // vol / sma20
    trendStrong1h: boolean
    adx1h: number
    adxMin: number
  }
  outcome: 'SIGNAL_LONG' | 'SIGNAL_SHORT' | 'BLOCKED_REGIME' | 'BLOCKED_1H_FILTERS' | 'BLOCKED_INSUFFICIENT_DATA'
  blockingFilters?: string[]   // nombres de los filtros 1h que fallaron, si aplica
  signalStrength?: number      // si genero senal
}

export async function logSignalTrace(userId: string, trace: SignalTrace): Promise<void> {
  // Resumen humano para el campo message
  const r = trace.regime
  const regimeStr = `${r.name} (ADX ${r.adx.toFixed(1)}, DI+ ${r.diPlus.toFixed(1)}/DI- ${r.diMinus.toFixed(1)}, slope ${r.slope >= 0 ? '+' : ''}${r.slope.toFixed(2)}%)`

  let msgSummary: string
  switch (trace.outcome) {
    case 'BLOCKED_REGIME':
      msgSummary = `🔵 ${trace.symbol}: ${regimeStr} → sin entrada (régimen no operable)`
      break
    case 'BLOCKED_1H_FILTERS':
      msgSummary = `🟡 ${trace.symbol}: ${regimeStr} → falló filtros 1h: ${trace.blockingFilters?.join(', ')}`
      break
    case 'SIGNAL_LONG':
      msgSummary = `🟢 ${trace.symbol}: ${regimeStr} → SEÑAL LONG (strength ${trace.signalStrength})`
      break
    case 'SIGNAL_SHORT':
      msgSummary = `🟢 ${trace.symbol}: ${regimeStr} → SEÑAL SHORT (strength ${trace.signalStrength})`
      break
    case 'BLOCKED_INSUFFICIENT_DATA':
      msgSummary = `⚫ ${trace.symbol}: datos insuficientes (menos de 210 velas)`
      break
  }

  await addLogForUser(userId, 'DEBUG', msgSummary, trace as any)
}
```

Nota sobre el nivel `DEBUG`: si la tabla `bot_logs` actualmente solo acepta `'INFO' | 'WARN' | 'ERROR'`, agregar `'DEBUG'` al check constraint con una migración pequeña:

```sql
-- supabase/migrations/004_add_debug_loglevel.sql
alter table bot_logs drop constraint if exists bot_logs_level_check;
alter table bot_logs add constraint bot_logs_level_check
  check (level in ('DEBUG','INFO','WARN','ERROR'));
```

### 2.2 Modificar `generateSignal` para emitir la traza

En `src/lib/strategy/signals.ts`, agregar un parámetro opcional al contexto y emitir el trace antes de cada return:

```typescript
export interface SignalContext {
  symbol: TradingSymbol
  candles1h: Candle[]
  candles4h: Candle[]
  currentPrice: number
  slAtrMult?: number
  tp1AtrMult?: number
  tp2AtrMult?: number
  userId?: string          // <-- NUEVO: si se pasa, se loguea trace
  traceEnabled?: boolean   // <-- NUEVO: gate global, default true
}

export async function generateSignal(ctx: SignalContext): Promise<Signal | null> {
  const { symbol, candles1h, candles4h, currentPrice, userId, traceEnabled = true } = ctx
  const shouldTrace = traceEnabled && userId !== undefined

  if (candles1h.length < 210 || candles4h.length < 210) {
    if (shouldTrace) {
      await logSignalTrace(userId!, {
        symbol, price: currentPrice,
        regime: { name:'N/A', adx:0, diPlus:0, diMinus:0, slope:0, allowLong:false, allowShort:false },
        outcome: 'BLOCKED_INSUFFICIENT_DATA',
      })
    }
    return null
  }

  const regime = analyzeRegime(candles4h, currentPrice)

  // Si bloquea por régimen, emitir trace y salir
  if (regime.regime === 'RANGING' || regime.regime === 'TRANSITION') {
    if (shouldTrace) {
      await logSignalTrace(userId!, {
        symbol, price: currentPrice,
        regime: {
          name: regime.regime, adx: regime.adx, diPlus: regime.diPlus, diMinus: regime.diMinus,
          slope: regime.emaSlope4h, allowLong: regime.allowLong, allowShort: regime.allowShort,
        },
        outcome: 'BLOCKED_REGIME',
      })
    }
    return null
  }

  const ind1h = calculateIndicators(candles1h)
  const ind1hPrev = calculateIndicatorsPrev(candles1h)
  const atr = ind1h.atr14
  if (!atr || atr === 0) return null

  const filters = FILTERS_BY_SYMBOL[symbol]
  const macdBullish = ind1h.macdHistogram > 0 && ind1h.macdHistogram > ind1hPrev.macdHistogram
  const macdBearish = ind1h.macdHistogram < 0 && ind1h.macdHistogram < ind1hPrev.macdHistogram
  const rsiLong  = ind1h.rsi14 >= 40 && ind1h.rsi14 <= 68
  const rsiShort = ind1h.rsi14 >= 32 && ind1h.rsi14 <= 60
  const stBullish = ind1h.superTrendDirection === 'UP'
  const stBearish = ind1h.superTrendDirection === 'DOWN'
  const lastVol = candles1h[candles1h.length - 1].volume
  const volumeConfirmed = lastVol >= ind1h.volumeSMA20 * filters.volumeMultiplier
  const trendStrong1h = ind1h.adx14 > filters.adxMin

  const isLong  = regime.allowLong  && macdBullish && rsiLong  && stBullish && volumeConfirmed && trendStrong1h
  const isShort = regime.allowShort && macdBearish && rsiShort && stBearish && volumeConfirmed && trendStrong1h

  // Construir filtros1h estructurado para la traza
  const filters1h = {
    macdBullish, macdBearish,
    macdHist: ind1h.macdHistogram, macdHistPrev: ind1hPrev.macdHistogram,
    rsiLong, rsiShort, rsi14: ind1h.rsi14,
    stBullish, stBearish, stDirection: ind1h.superTrendDirection as 'UP'|'DOWN',
    volumeConfirmed, volumeRatio: lastVol / ind1h.volumeSMA20,
    trendStrong1h, adx1h: ind1h.adx14, adxMin: filters.adxMin,
  }

  if (!isLong && !isShort) {
    // Identificar QUÉ filtros fallaron en la dirección que el régimen permite
    const blocking: string[] = []
    if (regime.allowLong) {
      if (!macdBullish)   blocking.push(`MACD no alcista (hist=${ind1h.macdHistogram.toFixed(4)}, prev=${ind1hPrev.macdHistogram.toFixed(4)})`)
      if (!rsiLong)       blocking.push(`RSI fuera de 40-68 (${ind1h.rsi14.toFixed(1)})`)
      if (!stBullish)     blocking.push(`SuperTrend no UP (${ind1h.superTrendDirection})`)
      if (!volumeConfirmed) blocking.push(`Volumen bajo (ratio ${(lastVol/ind1h.volumeSMA20).toFixed(2)} < ${filters.volumeMultiplier})`)
      if (!trendStrong1h) blocking.push(`ADX 1h débil (${ind1h.adx14.toFixed(1)} < ${filters.adxMin})`)
    } else if (regime.allowShort) {
      if (!macdBearish)   blocking.push(`MACD no bajista (hist=${ind1h.macdHistogram.toFixed(4)}, prev=${ind1hPrev.macdHistogram.toFixed(4)})`)
      if (!rsiShort)      blocking.push(`RSI fuera de 32-60 (${ind1h.rsi14.toFixed(1)})`)
      if (!stBearish)     blocking.push(`SuperTrend no DOWN (${ind1h.superTrendDirection})`)
      if (!volumeConfirmed) blocking.push(`Volumen bajo (ratio ${(lastVol/ind1h.volumeSMA20).toFixed(2)} < ${filters.volumeMultiplier})`)
      if (!trendStrong1h) blocking.push(`ADX 1h débil (${ind1h.adx14.toFixed(1)} < ${filters.adxMin})`)
    }
    if (shouldTrace) {
      await logSignalTrace(userId!, {
        symbol, price: currentPrice,
        regime: {
          name: regime.regime, adx: regime.adx, diPlus: regime.diPlus, diMinus: regime.diMinus,
          slope: regime.emaSlope4h, allowLong: regime.allowLong, allowShort: regime.allowShort,
        },
        filters1h, outcome: 'BLOCKED_1H_FILTERS', blockingFilters: blocking,
      })
    }
    return null
  }

  // ... resto identico (calculo de SL/TP, strength, etc.)
  const direction = isLong ? 1 : -1
  const slMult = ctx.slAtrMult ?? DEFAULT_SL_ATR_MULT
  const tp1Mult = ctx.tp1AtrMult ?? DEFAULT_TP1_ATR_MULT
  const tp2Mult = ctx.tp2AtrMult ?? DEFAULT_TP2_ATR_MULT
  const stopLoss = currentPrice - direction * atr * slMult
  const takeProfit1 = currentPrice + direction * atr * tp1Mult
  const takeProfit2 = currentPrice + direction * atr * tp2Mult
  const strength = calculateSignalStrength(ind1h, regime, isLong, volumeConfirmed, currentPrice)
  const reason = `${regime.reason} || 1H: ${buildReason(ind1h, isLong, atr, currentPrice)}`

  if (shouldTrace) {
    await logSignalTrace(userId!, {
      symbol, price: currentPrice,
      regime: {
        name: regime.regime, adx: regime.adx, diPlus: regime.diPlus, diMinus: regime.diMinus,
        slope: regime.emaSlope4h, allowLong: regime.allowLong, allowShort: regime.allowShort,
      },
      filters1h,
      outcome: isLong ? 'SIGNAL_LONG' : 'SIGNAL_SHORT',
      signalStrength: strength,
    })
  }

  return {
    symbol, type: isLong ? 'LONG' : 'SHORT', strength, price: currentPrice,
    stopLoss, takeProfit1, takeProfit2, indicators: ind1h, reason,
    timestamp: Date.now(), executed: false,
  }
}
```

### 2.3 Engine pasa userId al contexto

En `src/lib/trading-engine.ts`, donde se llama `generateSignal`, pasar `userId` y `traceEnabled: true`:

```typescript
const signal = await generateSignal({
  symbol,
  candles1h,
  candles4h,
  currentPrice,
  slAtrMult: config.slAtrMult,
  tp1AtrMult: config.tp1AtrMult,
  tp2AtrMult: config.tp2AtrMult,
  userId,                  // <-- NUEVO
  traceEnabled: true,      // <-- NUEVO
})
```

---

## 3. Anti-flooding (importante)

5 pares × 30 ticks/hora = 150 logs/hora por usuario. En 24h = 3,600 logs. Bien para diagnosticar las primeras horas, pero no queremos llenar la BD a largo plazo.

Dos protecciones:

**3.1 Cron de limpieza para logs DEBUG** (más agresivo que para INFO):

```sql
-- ya existe un cron de cleanup-logs (>7 dias). Agregar uno mas agresivo para DEBUG:
select cron.schedule(
  'cleanup-debug-logs',
  '0 * * * *',  -- cada hora
  $$ delete from bot_logs where level = 'DEBUG' and created_at < now() - interval '48 hours' $$
);
```

**3.2 Env var para desactivar el trace** cuando ya no se necesite:

```env
SIGNAL_TRACE_ENABLED=true   # default true; setear false en prod despues de validar
```

Y leerlo en el engine:

```typescript
const traceEnabled = process.env.SIGNAL_TRACE_ENABLED !== 'false'
```

---

## 4. Definition of Done

- [ ] `signal-trace.ts` creado.
- [ ] `generateSignal` emite trace en cada uno de los 4 puntos de retorno.
- [ ] Engine pasa `userId` y `traceEnabled` al contexto.
- [ ] Migración 004 aplicada (level `'DEBUG'` permitido).
- [ ] Cron `cleanup-debug-logs` programado.
- [ ] Deploy a prod (con `SHADOW_MODE=true` aún).
- [ ] Después de 2 horas correr esta query y compartirla aquí:

```sql
select 
  data->>'symbol' as symbol,
  data->>'outcome' as outcome,
  count(*) as n,
  jsonb_agg(distinct data->'regime'->>'name') as regimes_seen
from bot_logs
where level = 'DEBUG'
  and timestamp > now() - interval '2 hours'
  and data is not null
group by 1, 2
order by 1, 2;
```

Esa única query nos dirá, para cada uno de los 5 símbolos, en cuántos ticks fue bloqueado por régimen, en cuántos por filtros 1h, y en cuántos generó señal. Con eso sí podemos decidir si hay que ajustar umbrales o si hay un bug más profundo.

---

## 5. Cómo ejecutarlo

```bash
# 1. Desde el repo, en branch nueva
git checkout -b feature/observability-patch

# 2. Mover el spec al proyecto
mv ~/Downloads/PATCH_OBSERVABILITY.md docs/specs/

# 3. Commit
git add docs/specs/PATCH_OBSERVABILITY.md
git commit -m "docs: observability patch spec"

# 4. Claude Code, en una sola sesion:
```

**Prompt único:**
```
Lee docs/specs/PATCH_OBSERVABILITY.md. Implementa el parche completo en una sola sesión:
- src/lib/strategy/signal-trace.ts (nuevo)
- modificar src/lib/strategy/signals.ts para emitir trace en cada return
- modificar src/lib/trading-engine.ts donde llama generateSignal (pasar userId y traceEnabled)
- supabase/migrations/004_add_debug_loglevel.sql
- cron cleanup-debug-logs en SQL listo para correr en Supabase
- agregar SIGNAL_TRACE_ENABLED al .env.example

Verifica que compila. No toques lógica de trading.
```

Después: merge, deploy, esperar 2-3 horas, correr la query de la sección 4 DoD, pasarme el resultado.
