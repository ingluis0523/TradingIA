# Fase 1 — Addendum: Shadow Mode (Paper Trading)

> Suplemento al `01_PHASE_1_FOUNDATION.md`. Añade modo "shadow trading": el bot opera con precios reales del mercado pero **no ejecuta órdenes reales** en Binance. Útil para validar el sistema antes de arriesgar capital y para usuarios que quieren ver el bot funcionando antes de activarlo en real.

**Esta sección se implementa como parte de Fase 1**, después de las secciones 5 (trading-engine) y antes de la sección 11 (tests).

---

## 1. Modelo conceptual

Shadow mode = el motor opera idénticamente excepto que **no llama a `binance.placeOrder`, `cancelOrder`, `setLeverage`, ni `setMarginType`**. En su lugar:

- Las órdenes se simulan: se asume fill al `signal.price` para entradas, al `currentPrice` para cierres.
- Las posiciones simuladas se registran en la misma tabla `trades` con `is_shadow=true`.
- La detección de TP1/SL hits compara el precio actual con los niveles del trade en cada tick.
- Los fees se simulan al 0.04% del notional (taker fee real de Binance Futures).
- La reconciliación con Binance se omite para trades shadow.

**Lo que NO se simula y sí usa datos reales:**
- Klines (datos de mercado real, idénticos al modo live).
- Indicadores y señales (lógica idéntica).
- Balance del usuario en Binance (se lee para calcular allocatedCapital).

**Combinaciones válidas de modos:**

| TRADING_MODE | SHADOW_MODE | Caso de uso |
|---|---|---|
| testnet | false | Dev y testing de la integración Binance (estado actual) |
| testnet | true | Dev sin tocar testnet (no recomendado; usa el caso siguiente) |
| mainnet | true | **Paper trading con precios reales — recomendado para validación** |
| mainnet | false | Producción real |

---

## 2. Schema

Añadir a `001_multi_tenant_foundation.sql` (sección 2.2 del spec principal):

```sql
alter table trades
  add column if not exists is_shadow boolean not null default false;

create index if not exists trades_shadow_idx on trades (is_shadow);
create index if not exists trades_user_shadow_status_idx on trades (user_id, is_shadow, status);

-- Migración: trades existentes son reales (no shadow)
update trades set is_shadow = false where is_shadow is null;
```

El campo `is_shadow` es **inmutable** una vez creado el trade (un trade shadow no se promueve a real ni viceversa).

---

## 3. Detección del modo

Crear helper en `src/lib/trading-mode.ts`:

```typescript
export type TradingMode = 'testnet' | 'mainnet'

export interface ModeFlags {
  tradingMode: TradingMode
  shadowMode: boolean
}

export function getCurrentMode(): ModeFlags {
  const tradingMode = (process.env.TRADING_MODE || 'testnet') as TradingMode
  const shadowMode = process.env.SHADOW_MODE === 'true'
  
  if (!['testnet', 'mainnet'].includes(tradingMode)) {
    throw new Error(`TRADING_MODE inválido: ${tradingMode}. Debe ser 'testnet' o 'mainnet'.`)
  }
  
  return { tradingMode, shadowMode }
}

export function getBinanceBaseUrl(mode: TradingMode): string {
  return mode === 'mainnet'
    ? 'https://fapi.binance.com'
    : 'https://testnet.binancefuture.com'
}
```

En el `createBinanceClient` factory, usar `getBinanceBaseUrl` para el `baseUrl` si no se especifica.

---

## 4. Cambios en `trading-engine.ts`

### 4.1 En `runTradingTickForUser`

Lectura del modo al inicio:

```typescript
const { shadowMode } = getCurrentMode()

// La reconciliación con Binance solo aplica para trades NO-shadow
if (!shadowMode) {
  await reconcilePositions(userId, binance, account.positions, openTrades, config)
}
// Para trades shadow, no hay nada que reconciliar — son virtuales
```

Y al filtrar `openTrades`:

```typescript
const openTrades = await getOpenTradesForUser(userId)
// En shadow mode, manejamos solo trades shadow; en real mode, solo trades reales.
// Esto permite tener ambos modos coexistiendo si en el futuro hace falta.
const relevantOpenTrades = openTrades.filter(t => t.isShadow === shadowMode)
```

### 4.2 En `openPosition`

Branchear según el modo. Mantener la firma y la lógica de cálculo idénticas; solo cambia la "ejecución":

```typescript
async function openPosition(userId, signal, config, allocatedCapital, binance) {
  const { shadowMode } = getCurrentMode()
  
  // ... pasos 1-3 (leverage, margin type, position sizing) — solo en modo real ...
  if (!shadowMode) {
    await binance.setLeverage(signal.symbol, config.leverage)
    await binance.setMarginType(signal.symbol, 'ISOLATED')
  }
  
  const ps = calculatePositionSize(...)  // idéntico
  
  if (ps.quantity < symbolInfo.minQty) { /* ... */ return }
  
  const intentId = generateIntentId()
  // clientOrderIds se generan igual aunque en shadow no se usen — sirven como identificador interno
  
  // PASO 4: guardar trade PENDING (como en real, pero con is_shadow=true)
  const tradeId = await createTrade({
    userId,
    isShadow: shadowMode,
    status: shadowMode ? 'OPEN' : 'PENDING',  // shadow va directo a OPEN, no hay paso intermedio
    // ... resto idéntico ...
  })
  
  if (shadowMode) {
    // En shadow, simulamos fee y precio de entrada
    const simulatedFee = signal.price * ps.quantity * 0.0004  // 0.04% taker
    const actualEntryPrice = signal.price  // sin slippage simulado por ahora
    
    await updateTrade(tradeId, {
      actualEntryPrice,
      entryPrice: actualEntryPrice,
      fee: simulatedFee,
      binanceOrderId: `shadow-${tradeId}`,
      stopOrderId: `shadow-sl-${tradeId}`,
      tp1OrderId: `shadow-tp1-${tradeId}`,
      tp2OrderId: `shadow-tp2-${tradeId}`,
    })
    
    await logTrade(userId, `[SHADOW] ENTRADA ${side} ${signal.symbol} | Qty: ${ps.quantity} | Entry: ${actualEntryPrice} | SL: ${slPrice} | TP1: ${tp1Price} | TP2: ${tp2Price}`)
    return
  }
  
  // ... modo real: pasos 5-10 idénticos al spec original ...
}
```

### 4.3 En `managePosition`

Branch al inicio:

```typescript
async function managePosition(userId, trade, currentPrice, candles1h, config, binance, binancePosition) {
  if (trade.isShadow) {
    return manageShadowPosition(userId, trade, currentPrice, candles1h, config)
  }
  // ... lógica real existente ...
}

async function manageShadowPosition(userId, trade, currentPrice, candles1h, config) {
  const direction = trade.side === 'BUY' ? 1 : -1
  const symbolInfo = SYMBOL_INFO[trade.symbol]
  
  // 1. Check si SL fue tocado (simulado): comparar currentPrice con stopLoss según side
  const slHit = trade.side === 'BUY' 
    ? currentPrice <= trade.stopLoss 
    : currentPrice >= trade.stopLoss
  
  if (slHit) {
    return closeShadowPosition(userId, trade, trade.stopLoss, 'Stop Loss simulado')
  }
  
  // 2. Check si TP1 fue tocado y aún no marcado
  if (!trade.tp1Hit) {
    const tp1Hit = trade.side === 'BUY'
      ? currentPrice >= trade.takeProfit1
      : currentPrice <= trade.takeProfit1
    
    if (tp1Hit) {
      // Simular cierre parcial (50%): registra fee y PnL parcial, mueve SL a break-even
      const partialQty = trade.quantity * 0.5
      const partialPnl = (trade.takeProfit1 - trade.entryPrice) * direction * partialQty
      const partialFee = trade.takeProfit1 * partialQty * 0.0004
      
      const beSl = roundPrice(trade.entryPrice * (1 + direction * 0.001), symbolInfo.pricePrecision)
      
      await updateTrade(trade.id, {
        tp1Hit: true,
        stopLoss: beSl,
        // Acumulamos fee y registramos PnL parcial en notas o en un campo
        fee: trade.fee + partialFee,
        notes: `${trade.notes || ''} | TP1 simulado @ ${trade.takeProfit1}, partial PnL: +${partialPnl.toFixed(2)}`,
      })
      
      await logTrade(userId, `[SHADOW] TP1 simulado en ${trade.symbol} @ ${trade.takeProfit1} | SL movido a BE: ${beSl}`)
    }
  }
  
  // 3. Check si TP2 fue tocado (cierre total)
  if (trade.tp1Hit) {
    const tp2Hit = trade.side === 'BUY'
      ? currentPrice >= trade.takeProfit2
      : currentPrice <= trade.takeProfit2
    
    if (tp2Hit) {
      return closeShadowPosition(userId, trade, trade.takeProfit2, 'Take Profit 2 simulado')
    }
    
    // 4. Trailing stop simulado: misma lógica que real pero solo en BD
    if (candles1h.length >= 210) {
      const ind = calculateIndicators(candles1h)
      const newSl = calculateTrailingStop(trade, currentPrice, ind.atr14)
      if (newSl !== null) {
        const roundedSl = roundPrice(newSl, symbolInfo.pricePrecision)
        if (Math.abs(roundedSl - trade.stopLoss) / trade.stopLoss > 0.001) {
          await updateTrade(trade.id, { stopLoss: roundedSl })
          await logInfo(userId, `[SHADOW] Trailing stop ${trade.symbol}: ${roundedSl}`)
        }
      }
    }
  }
  
  // 5. Cierre anticipado por reversión (igual que real)
  if (candles1h.length >= 210) {
    if (shouldCloseEarly(trade.side, candles1h, currentPrice, trade.entryPrice)) {
      return closeShadowPosition(userId, trade, currentPrice, 'Cierre anticipado simulado (reversión)')
    }
  }
}

async function closeShadowPosition(userId: string, trade: Trade, exitPrice: number, reason: string) {
  const direction = trade.side === 'BUY' ? 1 : -1
  const remainingQty = trade.tp1Hit ? trade.quantity * 0.5 : trade.quantity
  
  // PnL final: considera si ya hubo cierre parcial en TP1
  let totalPnl: number
  if (trade.tp1Hit) {
    // 50% cerró en TP1, 50% cierra ahora
    const partialPnl = (trade.takeProfit1 - trade.entryPrice) * direction * (trade.quantity * 0.5)
    const remainingPnl = (exitPrice - trade.entryPrice) * direction * (trade.quantity * 0.5)
    totalPnl = partialPnl + remainingPnl
  } else {
    totalPnl = (exitPrice - trade.entryPrice) * direction * trade.quantity
  }
  
  const closeFee = exitPrice * remainingQty * 0.0004
  const totalFee = trade.fee + closeFee
  const netPnl = totalPnl - totalFee
  
  await updateTrade(trade.id, {
    status: 'CLOSED',
    exitPrice,
    actualExitPrice: exitPrice,
    realizedPnlBinance: totalPnl,  // PnL bruto antes de fees, simulado
    pnl: netPnl,
    pnlPct: (netPnl / (trade.entryPrice * trade.quantity / trade.leverage)) * 100,
    fee: totalFee,
    duration: Date.now() - new Date(trade.openedAt).getTime(),
    closedAt: new Date().toISOString(),
    notes: `[SHADOW] ${reason}`,
  })
  
  await logTrade(userId, `[SHADOW] CIERRE ${trade.symbol} @ ${exitPrice} | PnL: $${netPnl.toFixed(2)} | ${reason}`)
}
```

### 4.4 En `closePositionEarly` (real)

Si el modo es shadow, no llegamos a esta función — el flujo se redirige a `closeShadowPosition`. No hay cambios aquí.

---

## 5. Variables de entorno

Actualizar `.env.example`:

```env
# Modo de trading
TRADING_MODE=testnet           # testnet | mainnet
SHADOW_MODE=false              # true = paper trading sin órdenes reales

# Combinaciones recomendadas:
# - testnet + false  → dev y validación de integración Binance
# - mainnet + true   → paper trading con precios reales (validación pre-real)
# - mainnet + false  → producción real
```

---

## 6. UI: banner de modo en dashboard

En `src/components/dashboard/Navbar.tsx` (o donde corresponda), agregar un banner cuando el modo es shadow o testnet:

```typescript
// API endpoint nuevo: /api/system/mode → retorna {tradingMode, shadowMode}
// En el navbar, leer y mostrar banner.

{mode.shadowMode && (
  <div className="bg-yellow-500/20 border border-yellow-500/50 text-yellow-300 px-3 py-1.5 rounded text-xs font-medium">
    🔬 SHADOW MODE — operaciones simuladas, no se ejecutan órdenes reales
  </div>
)}

{mode.tradingMode === 'testnet' && !mode.shadowMode && (
  <div className="bg-blue-500/20 border border-blue-500/50 text-blue-300 px-3 py-1.5 rounded text-xs font-medium">
    🧪 TESTNET — operando con fondos de prueba
  </div>
)}

{mode.tradingMode === 'mainnet' && !mode.shadowMode && (
  <div className="bg-red-500/20 border border-red-500/50 text-red-300 px-3 py-1.5 rounded text-xs font-medium">
    🔴 MAINNET — operaciones con dinero real
  </div>
)}
```

Endpoint `/api/system/mode`:

```typescript
// src/app/api/system/mode/route.ts
import { NextResponse } from 'next/server'
import { getCurrentMode } from '@/lib/trading-mode'

export async function GET() {
  return NextResponse.json(getCurrentMode())
}
```

---

## 7. Métricas separadas

Cuando se calculen métricas en `getPerformanceMetrics`, por defecto se filtra solo `is_shadow=false`. Para análisis comparativo, agregar versión:

```typescript
export async function getPerformanceMetricsByMode(userId: string): Promise<{
  real: PerformanceMetrics
  shadow: PerformanceMetrics
}> {
  // Computa las métricas en paralelo para is_shadow=true y is_shadow=false
}
```

UI: en `/analytics` agregar toggle "Real / Shadow / Comparar" para que el usuario vea la diferencia.

---

## 8. Tests adicionales

Agregar al test plan de fase 1:

### Test 8: Shadow mode genera trades sin tocar Binance

1. Configurar `TRADING_MODE=mainnet`, `SHADOW_MODE=true` (con API keys reales solo lectura idealmente).
2. Iniciar el bot.
3. Esperar a que se genere una señal y se "abra" un trade.
4. **Esperado**:
   - Aparece un trade en BD con `is_shadow=true`, `binance_order_id` con prefijo `shadow-`.
   - En Binance Futures, ninguna posición fue abierta (verificar en la UI de Binance).
   - El log dice `[SHADOW] ENTRADA ...`.
   - El banner amarillo de SHADOW MODE aparece en el dashboard.

### Test 9: Shadow position se cierra cuando precio toca SL/TP

1. Tener un trade shadow abierto (de test 8 o creado a mano con valores cercanos al precio actual).
2. Esperar (o forzar simulación) hasta que el precio toque el TP1 simulado.
3. **Esperado**:
   - `tp1_hit=true`, SL en BD movido a break-even, fee acumulado.
   - Log dice `[SHADOW] TP1 simulado ...`.
   - No hay ninguna acción en Binance real.

### Test 10: Reconciliación ignora trades shadow

1. Tener trades shadow abiertos en BD.
2. Triggerar reconciliación (un tick del bot).
3. **Esperado**: los trades shadow no son tocados por la lógica de reconciliación (que solo opera sobre `is_shadow=false`). No se crean SL de emergencia para ellos.

---

## 9. Definition of Done — Adendum

- [ ] Schema actualizado con `is_shadow`.
- [ ] `trading-mode.ts` creado con `getCurrentMode()` y validación de env vars.
- [ ] `trading-engine.ts` branchea correctamente en `openPosition`, `managePosition`, `reconcilePositions`.
- [ ] Endpoint `/api/system/mode` retorna el modo actual.
- [ ] Banner visible en dashboard según modo.
- [ ] Tests 8, 9, 10 documentados como pasados.
- [ ] Probado el ciclo completo: mainnet + shadow=true durante 1 hora, se generan trades virtuales, no se ejecuta nada en Binance real.

---

## 10. Notas operativas

- Shadow mode **requiere API keys de Binance** porque se sigue leyendo el balance para calcular position sizing. Sugerencia: crear una API key con **permisos solo de lectura** (no Trading, no Futures Trading) específicamente para el modo shadow inicial. Cuando pases a real, generas key con permisos de Futures Trading.
- En shadow mode los fees son simulados (0.04%); pueden ser optimistas si Binance te tiene tier de fees peor. Conservador asumir 0.05% para tener margen.
- El precio de fill en shadow se asume igual al `signal.price`. En real puede haber slippage de 0.05-0.1% en pares líquidos. Si quieres ser más realista, añade slippage simulado de 0.05% al `actualEntryPrice` en contra del trade.
- Para tu uso personal: empieza shadow 2-3 semanas, mide win rate y PnL real, compara con lo que veías en testnet. Si dan números coherentes, switchea a real con capital pequeño.
