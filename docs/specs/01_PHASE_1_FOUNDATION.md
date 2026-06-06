# Fase 1: Foundation Refactor — Spec de Implementación

> **Objetivo**: arreglar todos los bugs críticos de ejecución del sistema actual y preparar el schema para multi-tenancy, **manteniendo el sistema operando single-user en Vercel cron** durante esta fase. La migración a Edge Functions y multi-user real ocurre en fase 3.

**Audiencia**: Claude Code  
**Pre-requisito**: leer `00_MASTER_SPEC.md`  
**Tiempo estimado**: 4-7 días de trabajo Claude Code  
**Estado al terminar**: sistema single-user estable corriendo en testnet con native orders, idempotencia, sin race conditions, schema multi-tenant-ready.

---

## 1. Pre-requisitos

- Branch nueva: `feature/phase-1-foundation` desde `main`.
- Backup completo de la BD actual de Supabase (export desde el dashboard).
- Confirmar que el bot está detenido en producción durante la migración.
- Confirmar que el switch de Binance está en **TESTNET** durante toda la fase 1. NO se opera mainnet hasta fase 5.

---

## 2. Migración de schema (multi-tenant ready, single-user funcional)

Crear archivo nuevo: `supabase/migrations/001_multi_tenant_foundation.sql`.

### 2.1 Nuevas tablas

```sql
-- Usuarios del sistema (incluye admin y traders)
-- En fase 1 solo existe el "system user", la integración con Supabase Auth viene en fase 2.
create table if not exists app_users (
  id              uuid primary key default gen_random_uuid(),
  email           text unique not null,
  display_name    text,
  role            text not null check (role in ('admin', 'trader', 'system')),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Configuración del bot por usuario (reemplaza la singleton bot_config)
create table if not exists user_bot_config (
  user_id                 uuid primary key references app_users(id) on delete cascade,
  is_running              boolean not null default false,
  symbols                 text[] not null default array['BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT'],
  leverage                integer not null default 3 check (leverage between 1 and 10),
  risk_per_trade          numeric(5,4) not null default 0.02 check (risk_per_trade between 0.005 and 0.05),
  max_positions           integer not null default 3 check (max_positions between 1 and 5),
  max_daily_loss          numeric(5,4) not null default 0.05 check (max_daily_loss between 0.02 and 0.10),
  trading_allocation_pct  numeric(5,4) not null default 0.50 check (trading_allocation_pct between 0.10 and 1.00),
  margin_type             text not null default 'ISOLATED' check (margin_type = 'ISOLATED'),
  strategy                text not null default 'AMSS',
  timeframe               text not null default '1h',
  min_signal_strength     integer not null default 60 check (min_signal_strength between 50 and 100),
  paused_until            timestamptz,  -- pausa temporal automática por daily loss
  paused_reason           text,
  updated_at              timestamptz not null default now()
);

-- Snapshot del capital asignado al inicio del día (para cálculos de % daily loss)
create table if not exists user_capital_snapshots (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_users(id) on delete cascade,
  snapshot_date   date not null,
  binance_balance numeric(20,8) not null,
  allocated_capital numeric(20,8) not null,
  created_at      timestamptz not null default now(),
  unique (user_id, snapshot_date)
);

-- Kill switch global
create table if not exists global_kill_switch (
  id              integer primary key default 1 check (id = 1),
  is_active       boolean not null default false,
  activated_by    uuid references app_users(id),
  activated_at    timestamptz,
  reason          text,
  updated_at      timestamptz not null default now()
);
insert into global_kill_switch (id, is_active) values (1, false) on conflict (id) do nothing;

-- Lock para cron concurrente (usado en fase 3, pero la tabla se crea ya)
create table if not exists cron_locks (
  lock_name       text primary key,
  locked_at       timestamptz not null,
  locked_by       text not null,  -- identificador del invocador (ej: invocation_id)
  expires_at      timestamptz not null
);
```

### 2.2 Modificar tablas existentes (añadir user_id)

```sql
-- trades: añadir user_id, no romper datos existentes
alter table trades
  add column if not exists user_id uuid references app_users(id) on delete restrict,
  add column if not exists client_order_id text,
  add column if not exists actual_entry_price numeric(20,8),  -- desde userTrades de Binance
  add column if not exists actual_exit_price numeric(20,8),   -- desde userTrades de Binance
  add column if not exists realized_pnl_binance numeric(20,8); -- PnL real de Binance, no calculado

create index if not exists trades_user_id_idx on trades (user_id);
create index if not exists trades_client_order_id_idx on trades (client_order_id) where client_order_id is not null;

-- bot_logs: añadir user_id (puede ser null para logs del sistema)
alter table bot_logs
  add column if not exists user_id uuid references app_users(id) on delete set null;
create index if not exists bot_logs_user_id_idx on bot_logs (user_id);

-- signals: NO se añade user_id; las señales son compartidas (provienen de la fase compartida del tick)
-- pero añadimos un timestamp de candle close para tracking de duplicados
alter table signals
  add column if not exists candle_close_at timestamptz,
  add column if not exists timeframe text default '1h';
create unique index if not exists signals_unique_candle_idx
  on signals (symbol, type, candle_close_at, timeframe)
  where candle_close_at is not null;
```

### 2.3 Migración de datos existentes

```sql
-- Crear el usuario system para mantener compatibilidad
insert into app_users (id, email, display_name, role)
values ('00000000-0000-0000-0000-000000000001', 'system@tradingia.local', 'System', 'system')
on conflict (id) do nothing;

-- Migrar la config singleton al user_bot_config del system user
insert into user_bot_config (user_id, is_running, symbols, leverage, risk_per_trade, max_positions, max_daily_loss, margin_type)
select 
  '00000000-0000-0000-0000-000000000001'::uuid,
  is_running,
  -- aplicar default sin SOL (decisión del spec)
  array(select unnest(symbols) except select 'SOLUSDT'),
  leverage,
  risk_per_trade,
  max_positions,
  max_daily_loss,
  'ISOLATED'  -- forzado
from bot_config where id = 1
on conflict (user_id) do nothing;

-- Asignar todos los trades existentes al system user
update trades set user_id = '00000000-0000-0000-0000-000000000001' where user_id is null;
update bot_logs set user_id = '00000000-0000-0000-0000-000000000001' where user_id is null;

-- Después de migrar, marcar user_id como not null
alter table trades alter column user_id set not null;
```

### 2.4 Deprecación de tabla `bot_config`

NO se elimina aún (mantenemos por compatibilidad en fase 1). Se elimina en fase 3 cuando todo lee de `user_bot_config`.

### 2.5 Aceptación de la migración

- [ ] La migración corre sin errores en una copia de la BD de producción.
- [ ] Todos los trades existentes tienen `user_id` poblado.
- [ ] El user system existe con ID `00000000-0000-0000-0000-000000000001`.
- [ ] `user_bot_config` tiene una fila para el system user con `symbols` sin SOL.
- [ ] Constraint `margin_type = 'ISOLATED'` rechaza intentos de insertar CROSS.

---

## 3. Refactor `src/lib/binance.ts`

### 3.1 Cambios estructurales

**Convertir el módulo de "singleton con env vars" a "factory que recibe credenciales"**. Esto prepara para multi-user sin romper el uso single-user.

```typescript
// Antes (singleton):
const API_KEY = process.env.BINANCE_API_KEY || ''
const API_SECRET = process.env.BINANCE_API_SECRET || ''

// Después (factory):
export interface BinanceCredentials {
  apiKey: string
  apiSecret: string
  baseUrl?: string  // default mainnet, testnet override per env
}

export function createBinanceClient(credentials: BinanceCredentials): BinanceClient {
  // ... retorna un objeto con todos los métodos vinculados a estas credenciales
}

// Para compatibilidad single-user en fase 1, exportar también un default client:
export const defaultClient = createBinanceClient({
  apiKey: process.env.BINANCE_API_KEY!,
  apiSecret: process.env.BINANCE_API_SECRET!,
  baseUrl: process.env.BINANCE_BASE_URL || 'https://testnet.binancefuture.com',
})
```

Todos los métodos actuales (`getKlines`, `getAccountInfo`, `placeOrder`, etc.) quedan como **métodos del cliente**, no exports sueltos. Para mantener compatibilidad temporal, exportar wrappers que delegan al `defaultClient`:

```typescript
export const getKlines = (...args) => defaultClient.getKlines(...args)
export const getAccountInfo = () => defaultClient.getAccountInfo()
// ...etc
```

### 3.2 Idempotencia: `newClientOrderId`

Toda orden de entrada y de SL/TP debe usar `newClientOrderId` único, derivado **determinísticamente** del intent del trade:

```typescript
function buildClientOrderId(prefix: string, userId: string, symbol: string, intentId: string): string {
  // Binance acepta hasta 36 chars, alphanumeric + algunos especiales
  // Formato: t-{prefix}-{userHash}-{intentHash}
  // userHash y intentHash son hashes cortos para no exceder 36 chars
  const userHash = userId.slice(0, 8)
  const intentHash = intentId.slice(0, 12)
  return `t-${prefix}-${userHash}-${intentHash}`.slice(0, 36)
}

// Ejemplos de prefijos:
// 'e' = entry order
// 'sl' = stop loss
// 't1' = take profit 1
// 't2' = take profit 2

// intentId es un UUID que identifica la decisión de trading (no la orden Binance).
// Si el código reintenta colocar la misma orden, mismo intentId → mismo clientOrderId → Binance dedupe.
```

`placeOrder` debe aceptar `clientOrderId` como parámetro opcional y enviarlo como `newClientOrderId` en la request a Binance.

### 3.3 Retry con backoff exponencial

Crear wrapper genérico:

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts: number; baseDelayMs: number; retryableStatuses?: number[] } = { maxAttempts: 3, baseDelayMs: 500 }
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      // No retry en errores de validación o autenticación
      if (err instanceof Error && (err.message.includes('-1100') || err.message.includes('-2010') || err.message.includes('-2014'))) {
        throw err
      }
      // No retry en último intento
      if (attempt === options.maxAttempts) break
      // Backoff: 500ms, 1s, 2s
      const delay = options.baseDelayMs * Math.pow(2, attempt - 1)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastError
}
```

Aplicar a operaciones críticas: `placeOrder`, `cancelOrder`, `getAccountInfo`, `setLeverage`, `setMarginType`.

NO aplicar retry a `getKlines` (es lectura, mejor fallar rápido).

### 3.4 Soporte explícito para órdenes nativas STOP_MARKET y TAKE_PROFIT_MARKET

Hoy `placeOrder` ya soporta `STOP_MARKET` y `TAKE_PROFIT_MARKET` como tipo, pero no se usan. Añadir helpers tipados que dejan clarísimo el uso:

```typescript
export interface PlaceStopMarketParams {
  symbol: TradingSymbol
  side: 'BUY' | 'SELL'           // SELL para cerrar LONG, BUY para cerrar SHORT
  stopPrice: number
  quantity: number
  reduceOnly: true                // siempre true para SL
  clientOrderId: string
}

async function placeStopMarket(params: PlaceStopMarketParams): Promise<OrderResponse> {
  return withRetry(() => placeOrder({
    symbol: params.symbol,
    side: params.side,
    type: 'STOP_MARKET',
    stopPrice: params.stopPrice,
    quantity: params.quantity,
    reduceOnly: true,
    timeInForce: 'GTC',
    workingType: 'MARK_PRICE',  // usar mark price, no last price; evita liquidaciones falsas por wicks
    clientOrderId: params.clientOrderId,
  }))
}

export interface PlaceTakeProfitMarketParams {
  symbol: TradingSymbol
  side: 'BUY' | 'SELL'
  stopPrice: number  // en TP, "stopPrice" es el trigger del TP
  quantity: number
  reduceOnly: true
  clientOrderId: string
}

async function placeTakeProfitMarket(params: PlaceTakeProfitMarketParams): Promise<OrderResponse> {
  return withRetry(() => placeOrder({
    symbol: params.symbol,
    side: params.side,
    type: 'TAKE_PROFIT_MARKET',
    stopPrice: params.stopPrice,
    quantity: params.quantity,
    reduceOnly: true,
    timeInForce: 'GTC',
    workingType: 'MARK_PRICE',
    clientOrderId: params.clientOrderId,
  }))
}
```

`PlaceOrderParams` debe extenderse con `workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'` y `newClientOrderId` (en el body Binance es `newClientOrderId`, en el código interno lo llamamos `clientOrderId`).

### 3.5 Nuevo helper: actualizar SL/TP existente

Binance no permite "modificar" una orden directamente; hay que cancelar y recolocar. Helper:

```typescript
export async function replaceStopLoss(
  symbol: TradingSymbol,
  oldOrderId: string | null,
  newParams: PlaceStopMarketParams
): Promise<OrderResponse> {
  if (oldOrderId) {
    try { await cancelOrder(symbol, parseInt(oldOrderId)) } catch (e) {
      // si ya fue cancelada o ejecutada, ignorar
      if (!(e instanceof Error && (e.message.includes('-2011') || e.message.includes('Unknown order')))) {
        throw e
      }
    }
  }
  return placeStopMarket(newParams)
}
```

### 3.6 Nuevo helper: query de userTrades (para PnL real)

Binance reporta fills reales via `/fapi/v1/userTrades`. Esto reemplaza el uso de `currentPrice` como proxy del exit price:

```typescript
export interface BinanceUserTrade {
  symbol: string
  id: number
  orderId: number
  side: 'BUY' | 'SELL'
  price: number
  qty: number
  realizedPnl: number
  commission: number
  commissionAsset: string
  time: number
}

export async function getUserTrades(
  symbol: TradingSymbol,
  options: { startTime?: number; endTime?: number; orderId?: number; limit?: number } = {}
): Promise<BinanceUserTrade[]> {
  const params: Record<string, string | number> = { symbol }
  if (options.startTime) params.startTime = options.startTime
  if (options.endTime) params.endTime = options.endTime
  if (options.orderId) params.orderId = options.orderId
  params.limit = options.limit || 100
  
  const raw = await request<any[]>('GET', '/fapi/v1/userTrades', params, true)
  return raw.map(t => ({
    symbol: t.symbol,
    id: t.id,
    orderId: t.orderId,
    side: t.side,
    price: parseFloat(t.price),
    qty: parseFloat(t.qty),
    realizedPnl: parseFloat(t.realizedPnl),
    commission: parseFloat(t.commission),
    commissionAsset: t.commissionAsset,
    time: t.time,
  }))
}
```

### 3.7 Fix de `setMarginType`: enforcement no silencioso

Hoy se ignora cualquier error que no contenga "No need to change". Cambiar a:

```typescript
export async function setMarginType(symbol: TradingSymbol, marginType: 'ISOLATED'): Promise<void> {
  // marginType solo acepta ISOLATED en este sistema
  try {
    await request('POST', '/fapi/v1/marginType', { symbol, marginType }, true)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('No need to change')) return  // ya estaba en ISOLATED, OK
    if (msg.includes('-4046')) return              // mismo significado, código de Binance
    // Cualquier otro error: throw — el caller decide si abortar el trade
    throw new Error(`No se pudo configurar margin type ISOLATED en ${symbol}: ${msg}. ` +
                    `Verifica que la cuenta no tenga posiciones abiertas en ${symbol} con CROSS y que el modo dual no esté activo.`)
  }
}
```

Si esto falla durante la apertura de un trade, el trade NO se abre. Mejor abortar que operar en modo incorrecto.

### 3.8 Aceptación módulo binance

- [ ] Todas las llamadas a `placeOrder` desde `trading-engine` incluyen `clientOrderId`.
- [ ] Reintentar el mismo `placeOrder` con mismo `clientOrderId` retorna la orden original (Binance dedupe), no crea duplicado.
- [ ] `placeStopMarket` y `placeTakeProfitMarket` usan `workingType: 'MARK_PRICE'`.
- [ ] `replaceStopLoss` con `oldOrderId = null` solo coloca la nueva sin intentar cancelar.
- [ ] `setMarginType` lanza error si Binance no acepta ISOLATED.
- [ ] `getUserTrades` retorna fills reales con `realizedPnl` poblado.

---

## 4. Refactor `src/lib/strategy/risk.ts`

### 4.1 Fix bug B3: daily loss check con signo

Antes (roto):
```typescript
if (dailyLoss >= config.maxDailyLoss * config.currentCapital) {
```

Después:
```typescript
// dailyLoss es negativo (suma de PnL perdedores); maxDailyLoss * capital es positivo
// La condición real: pérdida acumulada > umbral
if (Math.abs(Math.min(0, dailyLoss)) >= config.maxDailyLoss * config.currentCapital) {
```

O preferiblemente, refactorizar para que `calculateDailyLoss` retorne un valor positivo (pérdida) o cero, y `checkCanOpenPosition` compare directamente.

### 4.2 Fix bug B9: incluir unrealized PnL en daily loss

```typescript
export interface DailyLossSnapshot {
  realizedLoss: number      // suma de PnL perdedores cerrados hoy (positivo)
  unrealizedLoss: number    // suma de unrealized PnL negativo de posiciones abiertas (positivo)
  totalLoss: number         // realizedLoss + unrealizedLoss
}

export function calculateDailyLoss(
  closedTradesToday: Trade[],
  openPositions: { symbol: string; unrealizedPnl: number }[]
): DailyLossSnapshot {
  const realizedLoss = closedTradesToday
    .filter(t => (t.pnl ?? 0) < 0)
    .reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0)
  
  const unrealizedLoss = openPositions
    .filter(p => p.unrealizedPnl < 0)
    .reduce((s, p) => s + Math.abs(p.unrealizedPnl), 0)
  
  return {
    realizedLoss,
    unrealizedLoss,
    totalLoss: realizedLoss + unrealizedLoss,
  }
}
```

`checkCanOpenPosition` ahora compara contra `totalLoss`. El engine también debe pasar las `openPositions` desde el `AccountInfo`.

### 4.3 Cambio: subir `min_signal_strength` default de 52 a 60

En la config y en cualquier check hardcoded. Es un cambio de filtro: rechaza más señales mediocres. Con 30 trades históricos no es decisivo, pero es prudente.

### 4.4 Remover `kellyCriterion` (B13)

Dead code. Sacarlo. Si quieres tenerlo guardado, déjalo en un comment de TODO con referencia a "implementar como feature opcional en fase 5 para position sizing dinámico basado en win rate del usuario".

### 4.5 Aceptación módulo risk

- [ ] Daily loss check dispara cuando se simula con trades perdedores (test manual: insertar trades con PnL negativo sumando >5% en últimas 24h, intentar abrir nueva posición, debe ser rechazada).
- [ ] Daily loss incluye unrealized PnL negativo de posiciones abiertas.
- [ ] `min_signal_strength` configurable desde `user_bot_config`.
- [ ] `kellyCriterion` eliminado.

---

## 5. Refactor `src/lib/trading-engine.ts`

Este es el cambio más grande. Reescribir como **máquina de estados explícita** con flujos de apertura y cierre claros.

### 5.1 Nueva firma de la función principal

```typescript
export async function runTradingTickForUser(userId: string): Promise<UserTickResult> {
  // ... toda la lógica del tick para UN usuario específico
}

// Wrapper para mantener compatibilidad single-user durante fase 1
export async function runTradingTick(): Promise<EngineResult> {
  // Itera sobre usuarios activos. En fase 1, solo el system user.
  const activeUsers = await getActiveUsers()  // de app_users + user_bot_config.is_running
  const results: UserTickResult[] = []
  for (const user of activeUsers) {
    try {
      results.push(await runTradingTickForUser(user.id))
    } catch (err) {
      // log + continuar con siguiente usuario
    }
  }
  return aggregateResults(results)
}
```

### 5.2 Estructura interna de `runTradingTickForUser`

```typescript
async function runTradingTickForUser(userId: string): Promise<UserTickResult> {
  // 0. Verificar kill switches
  if (await isGlobalKillSwitchActive()) return earlyExit('kill_switch_global')
  
  // 1. Cargar config del usuario
  const config = await getUserBotConfig(userId)
  if (!config?.isRunning) return earlyExit('bot_stopped')
  if (config.pausedUntil && new Date(config.pausedUntil) > new Date()) {
    return earlyExit('paused_until', config.pausedReason)
  }
  
  // 2. Obtener credenciales Binance del usuario (en fase 1, viene del env)
  // En fase 2, se desencriptan desde Vault.
  const credentials = await getUserBinanceCredentials(userId)
  const binance = createBinanceClient(credentials)
  
  // 3. Obtener estado actual: cuenta + posiciones + open trades del usuario en BD
  const [account, openTrades] = await Promise.all([
    binance.getAccountInfo(),
    getOpenTradesForUser(userId),
  ])
  
  // 4. Calcular capital asignado del día (snapshot si no existe)
  const allocatedCapital = await getOrCreateDailyCapitalSnapshot(userId, account.totalWalletBalance, config.tradingAllocationPct)
  
  // 5. Reconciliación bidireccional (ver sección 5.3)
  await reconcilePositions(userId, binance, account.positions, openTrades, config)
  
  // 6. Check daily loss limit
  const dailyLoss = calculateDailyLoss(openTrades, account.positions)
  if (dailyLoss.totalLoss >= config.maxDailyLoss * allocatedCapital) {
    await pauseUntilNextDay(userId, `Daily loss alcanzado: ${dailyLoss.totalLoss.toFixed(2)} USDT`)
    return earlyExit('daily_loss_hit')
  }
  
  // 7. Para cada símbolo: manage existing position o evaluar entrada
  for (const symbol of config.symbols) {
    await processSymbolForUser(userId, symbol, binance, config, openTrades, account, allocatedCapital)
  }
  
  return success()
}
```

### 5.3 Reconciliación bidireccional (fix B2, B6)

Esta es la lógica crítica que previene posiciones huérfanas.

```typescript
async function reconcilePositions(
  userId: string,
  binance: BinanceClient,
  binancePositions: Position[],
  openTradesInDB: Trade[],
  config: UserBotConfig
): Promise<void> {
  // Caso A: posición en Binance, registro en BD → verificar consistencia (qty, side)
  // Caso B: posición en Binance, sin registro en BD → posición huérfana, crear registro + colocar SL/TP de emergencia
  // Caso C: registro en BD con status=OPEN, sin posición en Binance → posición fue cerrada externamente, marcar trade como CLOSED con PnL real de userTrades
  
  for (const bPos of binancePositions) {
    if (Math.abs(bPos.positionAmt) === 0) continue  // no es posición real
    if (!config.symbols.includes(bPos.symbol as TradingSymbol)) continue  // símbolo no monitoreado
    
    const dbTrade = openTradesInDB.find(t => t.symbol === bPos.symbol && t.status === 'OPEN')
    
    if (dbTrade) {
      // Caso A: consistencia
      const expectedQty = bPos.positionAmt > 0 ? dbTrade.quantity : -dbTrade.quantity
      if (Math.abs(expectedQty - bPos.positionAmt) > dbTrade.quantity * 0.01) {
        // Discrepancia >1%: log warning, mark trade with note, no auto-correct (manual investigation)
        await logWarn(userId, `Discrepancia qty en ${bPos.symbol}: DB=${dbTrade.quantity}, Binance=${bPos.positionAmt}`)
      }
      // Verificar que SL/TP nativos siguen en Binance, si no, recolocar
      await ensureProtectiveOrders(userId, binance, dbTrade, bPos)
    } else {
      // Caso B: huérfana
      await handleOrphanPosition(userId, binance, bPos, config)
    }
  }
  
  for (const dbTrade of openTradesInDB) {
    const bPos = binancePositions.find(p => p.symbol === dbTrade.symbol && Math.abs(p.positionAmt) > 0)
    if (!bPos) {
      // Caso C: cerrada externamente
      await closeTradeFromBinanceHistory(userId, binance, dbTrade)
    }
  }
}

async function handleOrphanPosition(userId: string, binance: BinanceClient, bPos: Position, config: UserBotConfig): Promise<void> {
  const side = bPos.positionAmt > 0 ? 'BUY' : 'SELL'
  const qty = Math.abs(bPos.positionAmt)
  const entryPrice = bPos.entryPrice
  const direction = side === 'BUY' ? 1 : -1
  
  // SL de emergencia: 2% del entry
  const emergencySL = entryPrice * (1 - direction * 0.02)
  const symbolInfo = SYMBOL_INFO[bPos.symbol as TradingSymbol]
  const slPrice = roundPrice(emergencySL, symbolInfo.pricePrecision)
  
  // Generar intentId nuevo y colocar SL nativo
  const intentId = generateIntentId()
  const slClientId = buildClientOrderId('sl', userId, bPos.symbol, intentId)
  
  let slOrderId: string | null = null
  try {
    const slOrder = await binance.placeStopMarket({
      symbol: bPos.symbol as TradingSymbol,
      side: side === 'BUY' ? 'SELL' : 'BUY',
      stopPrice: slPrice,
      quantity: qty,
      reduceOnly: true,
      clientOrderId: slClientId,
    })
    slOrderId = String(slOrder.orderId)
  } catch (e) {
    await logError(userId, `No se pudo colocar SL de emergencia para posición huérfana ${bPos.symbol}: ${e}`)
  }
  
  await createTrade({
    userId,
    symbol: bPos.symbol as TradingSymbol,
    side,
    status: 'OPEN',
    entryPrice,
    quantity: qty,
    leverage: config.leverage,
    stopLoss: slPrice,
    takeProfit1: roundPrice(entryPrice * (1 + direction * 0.03), symbolInfo.pricePrecision),
    takeProfit2: roundPrice(entryPrice * (1 + direction * 0.05), symbolInfo.pricePrecision),
    clientOrderId: intentId,
    stopOrderId: slOrderId,
    // tp1OrderId y tp2OrderId quedan null: no recolocamos TPs en huérfana, solo SL de emergencia
    notes: 'Reconciliada — posición existente en Binance sin registro en BD. SL emergencia colocado.',
    openedAt: new Date().toISOString(),
  })
}

async function closeTradeFromBinanceHistory(userId: string, binance: BinanceClient, dbTrade: Trade): Promise<void> {
  // Buscar el último fill cuando se cerró la posición
  const tradeOpenTime = new Date(dbTrade.openedAt).getTime()
  const userTrades = await binance.getUserTrades(dbTrade.symbol, { startTime: tradeOpenTime, limit: 50 })
  
  // Identificar fills de cierre (opuesto al side del trade)
  const closingSide = dbTrade.side === 'BUY' ? 'SELL' : 'BUY'
  const closingFills = userTrades.filter(t => t.side === closingSide)
  
  if (closingFills.length === 0) {
    await logWarn(userId, `Trade ${dbTrade.id} marcado como abierto en DB pero sin posición en Binance ni fills de cierre encontrados. Marcado como CANCELLED.`)
    await updateTrade(dbTrade.id, { status: 'CANCELLED', notes: 'No reconciliable' })
    return
  }
  
  // Calcular precio de cierre weighted average y PnL real desde Binance
  const totalQty = closingFills.reduce((s, t) => s + t.qty, 0)
  const weightedExitPrice = closingFills.reduce((s, t) => s + t.price * t.qty, 0) / totalQty
  const realizedPnl = closingFills.reduce((s, t) => s + t.realizedPnl, 0)
  const totalFee = closingFills.reduce((s, t) => s + t.commission, 0)
  
  const closeTime = Math.max(...closingFills.map(t => t.time))
  
  await updateTrade(dbTrade.id, {
    status: 'CLOSED',
    exitPrice: weightedExitPrice,
    actualExitPrice: weightedExitPrice,
    realizedPnlBinance: realizedPnl,
    pnl: realizedPnl - dbTrade.fee,  // pnl neto considerando fee de apertura + cierre
    pnlPct: (realizedPnl / (dbTrade.entryPrice * dbTrade.quantity / dbTrade.leverage)) * 100,
    fee: dbTrade.fee + totalFee,
    duration: closeTime - tradeOpenTime,
    closedAt: new Date(closeTime).toISOString(),
    notes: 'Cerrada por TP/SL nativo de Binance — PnL reconciliado desde userTrades',
  })
}
```

### 5.4 Apertura de posición (fix B1, B2, B4): orden de operaciones correcto

El orden actual (place order → save DB) es vulnerable. Nuevo orden:

```typescript
async function openPosition(userId: string, signal: Signal, config: UserBotConfig, allocatedCapital: number, binance: BinanceClient): Promise<void> {
  const symbolInfo = SYMBOL_INFO[signal.symbol]
  const side = signal.type === 'LONG' ? 'BUY' : 'SELL'
  const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY'
  
  // PASO 1: configurar leverage y margin type ANTES de la orden
  await binance.setLeverage(signal.symbol, config.leverage)
  await binance.setMarginType(signal.symbol, 'ISOLATED')  // throws si no se puede; abortamos el trade si esto falla
  
  // PASO 2: calcular position size con capital ASIGNADO (no balance total)
  const ps = calculatePositionSize(
    allocatedCapital,           // <-- capital del usuario asignado, no balance bruto
    config.riskPerTrade,
    signal.price,
    signal.stopLoss,
    config.leverage,
    symbolInfo.qtyPrecision
  )
  
  if (ps.quantity < symbolInfo.minQty) {
    await logWarn(userId, `Cantidad muy pequeña en ${signal.symbol}: ${ps.quantity} < ${symbolInfo.minQty}`)
    return
  }
  
  // PASO 3: generar intentId y clientOrderIds derivados
  const intentId = generateIntentId()
  const entryClientId = buildClientOrderId('e', userId, signal.symbol, intentId)
  const slClientId    = buildClientOrderId('sl', userId, signal.symbol, intentId)
  const tp1ClientId   = buildClientOrderId('t1', userId, signal.symbol, intentId)
  const tp2ClientId   = buildClientOrderId('t2', userId, signal.symbol, intentId)
  
  // PASO 4: guardar registro PRE-EJECUCIÓN en BD con status='PENDING'
  // Si la app crashea entre aquí y placeOrder, la próxima reconciliación detecta el PENDING y decide qué hacer
  const slPrice  = roundPrice(signal.stopLoss, symbolInfo.pricePrecision)
  const tp1Price = roundPrice(signal.takeProfit1, symbolInfo.pricePrecision)
  const tp2Price = roundPrice(signal.takeProfit2, symbolInfo.pricePrecision)
  
  const tradeId = await createTrade({
    userId,
    symbol: signal.symbol,
    side,
    status: 'PENDING',           // <-- NUEVO ESTADO
    entryPrice: signal.price,    // precio del signal, se sobreescribe con fill real después
    quantity: ps.quantity,
    leverage: config.leverage,
    stopLoss: slPrice,
    takeProfit1: tp1Price,
    takeProfit2: tp2Price,
    clientOrderId: intentId,
    openedAt: new Date().toISOString(),
  })
  
  // PASO 5: colocar orden MARKET de entrada con clientOrderId
  let entryOrder: OrderResponse
  try {
    entryOrder = await binance.placeOrder({
      symbol: signal.symbol,
      side,
      type: 'MARKET',
      quantity: ps.quantity,
      clientOrderId: entryClientId,
    })
  } catch (e) {
    // Si falla la entrada, marcar el trade como CANCELLED
    await updateTrade(tradeId, { status: 'CANCELLED', notes: `Entrada fallida: ${e instanceof Error ? e.message : String(e)}` })
    throw e
  }
  
  // PASO 6: obtener fill real (puede haber slippage)
  // Esperar brevemente para que Binance procese
  await new Promise(r => setTimeout(r, 500))
  const fills = await binance.getUserTrades(signal.symbol, { orderId: entryOrder.orderId, limit: 10 })
  const totalFillQty = fills.reduce((s, f) => s + f.qty, 0)
  const actualEntryPrice = totalFillQty > 0
    ? fills.reduce((s, f) => s + f.price * f.qty, 0) / totalFillQty
    : signal.price  // fallback al signal price
  const totalEntryFee = fills.reduce((s, f) => s + f.commission, 0)
  
  // PASO 7: colocar SL nativo
  let slOrderId: string | null = null
  try {
    const slOrder = await binance.placeStopMarket({
      symbol: signal.symbol,
      side: oppositeSide,
      stopPrice: slPrice,
      quantity: ps.quantity,
      reduceOnly: true,
      clientOrderId: slClientId,
    })
    slOrderId = String(slOrder.orderId)
  } catch (e) {
    // CRÍTICO: la posición está abierta sin SL. Intentar cerrarla inmediatamente.
    await logError(userId, `No se pudo colocar SL nativo en ${signal.symbol}, intentando cerrar posición de emergencia: ${e}`)
    try {
      await binance.placeOrder({
        symbol: signal.symbol,
        side: oppositeSide,
        type: 'MARKET',
        quantity: ps.quantity,
        reduceOnly: true,
        clientOrderId: buildClientOrderId('emer', userId, signal.symbol, intentId),
      })
      await updateTrade(tradeId, { status: 'CANCELLED', notes: 'Cerrada de emergencia por fallo en colocación de SL nativo' })
      return
    } catch (closeErr) {
      // Aún peor: no se puede cerrar. Loggear severamente y dejar al admin manejarlo.
      await logError(userId, `FALLO CRÍTICO: posición abierta sin SL y no se pudo cerrar. Intervención manual requerida. Trade ID: ${tradeId}`)
      throw closeErr
    }
  }
  
  // PASO 8: colocar TP1 (50% de la cantidad)
  const tp1Qty = roundQty(ps.quantity * 0.5, symbolInfo.qtyPrecision)
  let tp1OrderId: string | null = null
  if (tp1Qty >= symbolInfo.minQty) {
    try {
      const tp1Order = await binance.placeTakeProfitMarket({
        symbol: signal.symbol,
        side: oppositeSide,
        stopPrice: tp1Price,
        quantity: tp1Qty,
        reduceOnly: true,
        clientOrderId: tp1ClientId,
      })
      tp1OrderId = String(tp1Order.orderId)
    } catch (e) {
      await logWarn(userId, `TP1 no colocado en ${signal.symbol}: ${e}. Continuando, el SL nativo protege.`)
    }
  }
  
  // PASO 9: colocar TP2 (50% restante)
  const tp2Qty = roundQty(ps.quantity - tp1Qty, symbolInfo.qtyPrecision)
  let tp2OrderId: string | null = null
  if (tp2Qty >= symbolInfo.minQty) {
    try {
      const tp2Order = await binance.placeTakeProfitMarket({
        symbol: signal.symbol,
        side: oppositeSide,
        stopPrice: tp2Price,
        quantity: tp2Qty,
        reduceOnly: true,
        clientOrderId: tp2ClientId,
      })
      tp2OrderId = String(tp2Order.orderId)
    } catch (e) {
      await logWarn(userId, `TP2 no colocado en ${signal.symbol}: ${e}. El SL nativo protege.`)
    }
  }
  
  // PASO 10: actualizar trade con todos los IDs y precio real, mover status a OPEN
  await updateTrade(tradeId, {
    status: 'OPEN',
    actualEntryPrice,
    entryPrice: actualEntryPrice,  // sobreescribe con el real
    binanceOrderId: String(entryOrder.orderId),
    stopOrderId: slOrderId,
    tp1OrderId,
    tp2OrderId,
    fee: totalEntryFee,
  })
  
  await logTrade(userId, `ENTRADA ${side} ${signal.symbol} | Qty: ${ps.quantity} | Entry: ${actualEntryPrice} | SL: ${slPrice} (orden ${slOrderId}) | TP1: ${tp1Price} | TP2: ${tp2Price}`)
}
```

### 5.5 Gestión de posición existente (fix B5, B8)

```typescript
async function managePosition(
  userId: string,
  trade: Trade,
  currentPrice: number,
  candles1h: Candle[],
  config: UserBotConfig,
  binance: BinanceClient,
  binancePosition: Position | undefined
): Promise<void> {
  // Si Binance ya no tiene la posición, la reconciliación previa ya la cerró. Nada que hacer aquí.
  if (!binancePosition) return
  
  const symbolInfo = SYMBOL_INFO[trade.symbol]
  const direction = trade.side === 'BUY' ? 1 : -1
  const oppositeSide = trade.side === 'BUY' ? 'SELL' : 'BUY'
  
  // 1. Verificar si TP1 fue ejecutado (consultando si la orden tp1 sigue activa)
  if (trade.tp1OrderId && !trade.tp1Hit) {
    const tp1Status = await binance.getOrderStatus(trade.symbol, parseInt(trade.tp1OrderId))
    if (tp1Status === 'FILLED') {
      // TP1 ejecutado: mover SL a break-even
      const beSl = roundPrice(trade.entryPrice * (1 + direction * 0.001), symbolInfo.pricePrecision)
      const newSlClientId = buildClientOrderId('sl-be', userId, trade.symbol, trade.clientOrderId || trade.id)
      
      const remainingQty = roundQty(trade.quantity - parseFloat(trade.quantity.toString()) * 0.5, symbolInfo.qtyPrecision)
      
      const newSl = await binance.replaceStopLoss(trade.symbol, trade.stopOrderId, {
        symbol: trade.symbol,
        side: oppositeSide,
        stopPrice: beSl,
        quantity: remainingQty,
        reduceOnly: true,
        clientOrderId: newSlClientId,
      })
      
      await updateTrade(trade.id, {
        tp1Hit: true,
        stopLoss: beSl,
        stopOrderId: String(newSl.orderId),
      })
      
      await logTrade(userId, `TP1 ejecutado en ${trade.symbol}, SL movido a break-even ${beSl}`)
    }
  }
  
  // 2. Trailing stop después de TP1 (si está habilitado)
  if (trade.tp1Hit && candles1h.length >= 210) {
    const indicators = calculateIndicators(candles1h)
    const newTrailingSl = calculateTrailingStop(trade, currentPrice, indicators.atr14)
    
    if (newTrailingSl !== null) {
      const roundedSl = roundPrice(newTrailingSl, symbolInfo.pricePrecision)
      
      // Solo actualizar si el nuevo SL es materialmente diferente (>0.1%)
      if (Math.abs(roundedSl - trade.stopLoss) / trade.stopLoss > 0.001) {
        const newSlClientId = buildClientOrderId('sl-tr', userId, trade.symbol, `${trade.clientOrderId}-${Date.now()}`)
        const remainingQty = roundQty(trade.quantity * 0.5, symbolInfo.qtyPrecision)  // 50% restante tras TP1
        
        try {
          const updated = await binance.replaceStopLoss(trade.symbol, trade.stopOrderId, {
            symbol: trade.symbol,
            side: oppositeSide,
            stopPrice: roundedSl,
            quantity: remainingQty,
            reduceOnly: true,
            clientOrderId: newSlClientId,
          })
          
          await updateTrade(trade.id, {
            stopLoss: roundedSl,
            stopOrderId: String(updated.orderId),
          })
          
          await logInfo(userId, `Trailing stop actualizado en ${trade.symbol}: ${roundedSl}`)
        } catch (e) {
          await logWarn(userId, `Fallo al actualizar trailing stop en ${trade.symbol}: ${e}`)
        }
      }
    }
  }
  
  // 3. Cierre anticipado por reversión de tendencia
  if (candles1h.length >= 210) {
    if (shouldCloseEarly(trade.side, candles1h, currentPrice, trade.entryPrice)) {
      await closePositionEarly(userId, binance, trade, 'Señal de cierre anticipado (reversión de tendencia)')
    }
  }
}

async function closePositionEarly(userId: string, binance: BinanceClient, trade: Trade, reason: string): Promise<void> {
  const oppositeSide = trade.side === 'BUY' ? 'SELL' : 'BUY'
  
  // 1. Cancelar todas las órdenes de protección
  for (const orderId of [trade.stopOrderId, trade.tp1OrderId, trade.tp2OrderId]) {
    if (orderId) {
      try { await binance.cancelOrder(trade.symbol, parseInt(orderId)) } catch {}
    }
  }
  
  // 2. Cierre MARKET con reduceOnly
  const closeClientId = buildClientOrderId('close', userId, trade.symbol, `${trade.clientOrderId}-close`)
  const closeOrder = await binance.placeOrder({
    symbol: trade.symbol,
    side: oppositeSide,
    type: 'MARKET',
    quantity: trade.quantity,
    reduceOnly: true,
    clientOrderId: closeClientId,
  })
  
  // 3. Obtener fill real
  await new Promise(r => setTimeout(r, 500))
  const fills = await binance.getUserTrades(trade.symbol, { orderId: closeOrder.orderId, limit: 10 })
  const totalQty = fills.reduce((s, f) => s + f.qty, 0)
  const actualExitPrice = totalQty > 0 ? fills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty : 0
  const realizedPnl = fills.reduce((s, f) => s + f.realizedPnl, 0)
  const closeFee = fills.reduce((s, f) => s + f.commission, 0)
  
  await updateTrade(trade.id, {
    status: 'CLOSED',
    exitPrice: actualExitPrice,
    actualExitPrice,
    realizedPnlBinance: realizedPnl,
    pnl: realizedPnl - trade.fee - closeFee,
    pnlPct: (realizedPnl / (trade.entryPrice * trade.quantity / trade.leverage)) * 100,
    fee: trade.fee + closeFee,
    duration: Date.now() - new Date(trade.openedAt).getTime(),
    closedAt: new Date().toISOString(),
    notes: reason,
  })
  
  await logTrade(userId, `CIERRE anticipado ${trade.symbol} | PnL: $${realizedPnl.toFixed(2)} | ${reason}`)
}
```

### 5.6 Fix B7: capital calculation

```typescript
// Antes (mal):
const newCapital = account.totalMarginBalance + account.totalUnrealizedPnl  // double-counting

// Después:
// totalMarginBalance ya incluye unrealized PnL en Binance
const newWalletBalance = account.totalWalletBalance  // solo wallet, sin unrealized
const newMarginBalance = account.totalMarginBalance   // wallet + unrealized

// El "currentCapital" del usuario es el balance asignado, no total
// Se calcula en getOrCreateDailyCapitalSnapshot al inicio de cada día
```

### 5.7 Eliminar `bot_config` singleton del código

Reemplazar todas las lecturas de `bot_config` por `getUserBotConfig(userId)`. En fase 1, el `userId` siempre es el system user.

### 5.8 Aceptación módulo trading-engine

- [ ] Trade abierto tiene los 4 IDs poblados: `binanceOrderId`, `stopOrderId`, `tp1OrderId`, `tp2OrderId`.
- [ ] Trade con status `PENDING` solo existe transitoriamente (durante la ejecución del openPosition); al finalizar es `OPEN` o `CANCELLED`.
- [ ] Matar el servidor a mitad de `openPosition` (entre paso 5 y paso 8) y reiniciar: la siguiente reconciliación cierra/protege la posición.
- [ ] `actualEntryPrice` y `actualExitPrice` poblados desde fills reales de Binance.
- [ ] `realizedPnlBinance` coincide con lo que reporta Binance en el extracto.
- [ ] El trailing stop modifica la orden nativa en Binance, no solo la BD.
- [ ] `currentCapital` no se infla por double-counting.

---

## 6. Refactor `src/lib/strategy/signals.ts`

Cambios menores:

### 6.1 Fix B11: tolerancia EMA200

```typescript
// Antes:
const bullishTrend4h = ind4h.ema20 > ind4h.ema50 && currentPrice > ind4h.ema200 * 0.97
const bearishTrend4h = ind4h.ema20 < ind4h.ema50 && currentPrice < ind4h.ema200 * 1.03

// Después: tolerancia 1% por default, configurable
const ema200Tolerance = 0.01  // 1%
const bullishTrend4h = ind4h.ema20 > ind4h.ema50 && currentPrice > ind4h.ema200 * (1 - ema200Tolerance)
const bearishTrend4h = ind4h.ema20 < ind4h.ema50 && currentPrice < ind4h.ema200 * (1 + ema200Tolerance)
```

### 6.2 Parámetros configurables por símbolo (preparación para BTC con filtros relajados)

```typescript
interface SymbolFilters {
  adxMin: number
  ema200Tolerance: number
  volumeMultiplier: number
}

const FILTERS_BY_SYMBOL: Record<TradingSymbol, SymbolFilters> = {
  BTCUSDT: { adxMin: 18, ema200Tolerance: 0.01, volumeMultiplier: 0.9 },
  ETHUSDT: { adxMin: 20, ema200Tolerance: 0.01, volumeMultiplier: 1.0 },
  BNBUSDT: { adxMin: 20, ema200Tolerance: 0.01, volumeMultiplier: 1.0 },
  XRPUSDT: { adxMin: 20, ema200Tolerance: 0.01, volumeMultiplier: 1.0 },
  SOLUSDT: { adxMin: 25, ema200Tolerance: 0.005, volumeMultiplier: 1.2 },  // si se reactiva, más estricto
}

// Aplicar el filtro correspondiente al símbolo en generateSignal
```

### 6.3 Aceptación signals

- [ ] BTC genera señales con filtros relajados (verificar con datos históricos: debe pasar más checks que ETH en el mismo período).
- [ ] La tolerancia de 1% rechaza señales que la de 3% aceptaba (verificar manualmente con un caso reciente).

---

## 7. Actualizar `src/types/trading.ts`

```typescript
// Cambios:
export type TradeStatus = 'PENDING' | 'OPEN' | 'CLOSED' | 'CANCELLED' | 'PARTIAL'  // <-- agregar PENDING

export interface Trade {
  // ...campos existentes...
  userId: string                      // NUEVO
  clientOrderId?: string              // NUEVO (intentId)
  actualEntryPrice?: number           // NUEVO
  actualExitPrice?: number            // NUEVO
  realizedPnlBinance?: number         // NUEVO
}

// Eliminar interface BotConfig (singleton) — reemplazar por UserBotConfig
export interface UserBotConfig {
  userId: string
  isRunning: boolean
  symbols: TradingSymbol[]
  leverage: number
  riskPerTrade: number
  maxPositions: number
  maxDailyLoss: number
  tradingAllocationPct: number       // NUEVO
  marginType: 'ISOLATED'             // forzado
  strategy: string
  timeframe: string
  minSignalStrength: number          // NUEVO
  pausedUntil?: string               // NUEVO
  pausedReason?: string              // NUEVO
  updatedAt: string
}

export interface AppUser {
  id: string
  email: string
  displayName?: string
  role: 'admin' | 'trader' | 'system'
  isActive: boolean
  createdAt: string
  updatedAt: string
}
```

Default symbols (sin SOL):
```typescript
export const DEFAULT_SYMBOLS: TradingSymbol[] = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT']
// TRADING_SYMBOLS sigue exportando los 5 para que el admin pueda re-habilitar SOL si quiere
```

---

## 8. Actualizar `src/lib/supabase.ts`

Crear nuevos métodos:

```typescript
// Usuarios
export async function getAppUser(userId: string): Promise<AppUser | null>
export async function getActiveTradingUsers(): Promise<AppUser[]>  // bot=ON, role=trader|system, isActive=true

// Config por usuario
export async function getUserBotConfig(userId: string): Promise<UserBotConfig | null>
export async function updateUserBotConfig(userId: string, updates: Partial<UserBotConfig>): Promise<void>

// Trades por usuario
export async function getOpenTradesForUser(userId: string): Promise<Trade[]>
export async function getRecentTradesForUser(userId: string, limit?: number): Promise<Trade[]>

// Capital snapshot
export async function getOrCreateDailyCapitalSnapshot(userId: string, binanceBalance: number, allocationPct: number): Promise<number>

// Kill switches
export async function isGlobalKillSwitchActive(): Promise<boolean>
export async function setGlobalKillSwitch(active: boolean, userId: string, reason?: string): Promise<void>

// Logs
export async function addLogForUser(userId: string, level: BotLog['level'], message: string, data?: any): Promise<void>

// Pausas automáticas
export async function pauseUserUntil(userId: string, until: Date, reason: string): Promise<void>
```

Las funciones existentes (`getBotConfig`, `getOpenTrades`, etc.) quedan como wrappers que llaman a las nuevas con el system user para no romper compatibilidad en fase 1.

---

## 9. Actualizar API routes

Cambios mínimos en fase 1, solo para pasar `userId` (system user) explícitamente:

### `src/app/api/cron/trade/route.ts`

```typescript
// Pre-fase 3: sigue siendo cron de Vercel
// Cambio: iterar usuarios activos en vez de ejecutar uno solo

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  // Verificar kill switch global
  if (await isGlobalKillSwitchActive()) {
    return NextResponse.json({ success: true, message: 'Global kill switch active' })
  }
  
  // En fase 1, solo opera el system user
  const result = await runTradingTick()  // que internamente itera usuarios activos
  return NextResponse.json(result)
}
```

### `src/app/api/bot/start/route.ts` y `/stop`

Cambios para usar `updateUserBotConfig(SYSTEM_USER_ID, { isRunning: true/false })`.

---

## 10. Variables de entorno

Añadir a `.env.example`:

```env
# Sistema (Phase 1)
SYSTEM_USER_ID=00000000-0000-0000-0000-000000000001

# Switch entre testnet y mainnet
TRADING_MODE=testnet  # testnet | mainnet
BINANCE_BASE_URL=https://testnet.binancefuture.com

# Modo shadow (no ejecutar órdenes, solo registrar señales)
SHADOW_MODE=false
```

---

## 11. Tests manuales obligatorios

Antes de mergear fase 1 a `main`:

### Test 1: Resilience al crash mid-trade
1. Iniciar el bot en testnet.
2. Generar una señal manualmente (puede ser inyectada en BD para testing).
3. Detener el servidor abruptamente justo después de que `placeOrder` retorna pero antes de que `updateTrade` complete el status=OPEN.
4. Reiniciar el bot.
5. **Esperado**: la siguiente reconciliación detecta el trade en `PENDING` o la posición huérfana, coloca SL de emergencia, marca el trade como `OPEN` o `CANCELLED` apropiadamente.

### Test 2: Native SL ejecuta cuando el bot está caído
1. Abrir un trade en testnet con SL nativo activo.
2. Detener el bot completamente.
3. Forzar el precio (en testnet puedes esperar o operar manualmente en el book) para que toque el SL.
4. **Esperado**: la orden nativa de SL se ejecuta en Binance sin que el bot esté corriendo. La siguiente vez que el bot arranque, reconcilia el trade como `CLOSED` con PnL real.

### Test 3: Idempotencia
1. Iniciar `openPosition` con un intentId fijo.
2. Antes de que termine, llamar a `openPosition` con el mismo intentId.
3. **Esperado**: la segunda llamada no crea una nueva posición; Binance retorna la orden ya existente.

### Test 4: Daily loss circuit breaker
1. Insertar manualmente en BD 3-4 trades cerrados con PnL negativo sumando >5% del capital del system user.
2. Triggerar un tick.
3. **Esperado**: el tick detecta el daily loss, pausa el bot hasta el próximo día, registra el motivo.

### Test 5: SL nativo con MARK_PRICE no se ejecuta en wicks
1. Abrir un trade con SL en testnet.
2. Verificar en Binance UI que la orden de SL tiene `workingType: MARK_PRICE`.
3. **Esperado**: durante un wick del precio último que no afecta mark price, el SL no se dispara (test difícil de simular en testnet, pero al menos verificar el flag).

### Test 6: Margin type mismatch
1. Manualmente en Binance Futures, abrir y cerrar una posición en BTCUSDT con margen CROSS (sin involucrar al bot).
2. Iniciar el bot.
3. **Esperado**: el bot intenta operar en BTCUSDT, llama a `setMarginType ISOLATED`, debe lograrlo (no hay posición abierta) y proceder normalmente. Si hubiera posición CROSS abierta, debería abortar el trade con error claro.

### Test 7: PnL real vs calculado
1. Abrir y cerrar un trade en testnet.
2. Comparar `pnl` (calculado), `realized_pnl_binance` (real de Binance), y el extracto de Binance.
3. **Esperado**: los tres coinciden ±0.5%.

---

## 12. Plan de testing automatizado (mínimo viable)

No se piden tests unitarios exhaustivos en fase 1, pero sí:

- Crear `src/lib/strategy/__tests__/indicators.test.ts` con tests básicos (EMA, RSI, MACD, ATR) usando datos fijos conocidos.
- Crear `src/lib/strategy/__tests__/risk.test.ts` cubriendo: position sizing, calculateDailyLoss (con casos de unrealized), checkCanOpenPosition (caso daily loss hit, caso max positions hit).

Setup con `vitest`. Añadir al `package.json`:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

---

## 13. Definition of Done — Fase 1

- [ ] Todos los bugs B1-B13 resueltos.
- [ ] Migración SQL ejecutada sin errores en BD de testnet.
- [ ] 7 tests manuales pasan documentadamente (con screenshots o logs en un doc).
- [ ] Tests automatizados de `indicators` y `risk` pasan.
- [ ] El bot corre 48 horas continuas en testnet con la nueva versión sin trades huérfanos ni errores críticos en logs.
- [ ] El system user opera normalmente, abre y cierra trades, los PnL reportados coinciden con extracto.
- [ ] Branch `feature/phase-1-foundation` mergeada a `main` con review.
- [ ] Tag `v0.2.0-foundation` creado.

**Cuando fase 1 esté DONE, se inicia fase 2 con su propio spec.**

---

## 14. Notas y precauciones para Claude Code

- No tocar el dashboard UI en esta fase salvo lo estrictamente necesario para que compile. Los cambios de UI van en fase 4.
- No introducir nuevas dependencias salvo `vitest` para tests.
- Cuando modifiques `trading-engine.ts`, hazlo en un archivo nuevo `trading-engine-v2.ts` y luego renombra para reemplazar; **no edites el archivo grande in-place** (es propenso a errores).
- Toda función nueva debe tener JSDoc con explicación de su rol en el flujo.
- Si encuentras un caso edge no cubierto por este spec, no improvisar: pausar y consultar con Luis antes de tomar decisión.
- Los `logError`, `logWarn`, `logInfo`, `logTrade` deben siempre incluir el `userId` cuando hay uno (en fase 1 será el system user, pero el código ya lo prepara para multi-tenant).
