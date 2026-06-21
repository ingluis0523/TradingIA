/**
 * trading-engine.ts — Multi-tenant engine with native SL/TP, state machine,
 * bidirectional reconciliation, PnL from userTrades, and crash-safe PENDING status.
 *
 * Phase 1: still operates as single-user via SYSTEM_USER_ID.
 * Phase 2+: runTradingTick() iterates over all active users from user_bot_config.
 */

import {
  defaultClient,
  buildClientOrderId,
  generateIntentId,
  roundPrice,
  roundQty,
} from './binance'
import { generateSignal, shouldCloseEarly } from './strategy/signals'
import {
  calculatePositionSize,
  checkCanOpenPosition,
  calculateDailyLoss,
  calculateTrailingStop,
  validateRiskReward,
  evaluateCircuitBreaker,
  type DailyLossSnapshot,
  type CircuitBreakerState,
} from './strategy/risk'
import { calculateIndicators } from './strategy/indicators'
import {
  saveSignal,
  SYSTEM_USER_ID,
  isGlobalKillSwitchActive,
  getActiveTradingUsers,
  getUserBotConfig,
  getOpenTradesForUser,
  getRecentTradesForUser,
  pauseUserUntil,
  createTrade,
  updateTrade,
  addLogForUser,
} from './supabase'
import { getCurrentMode } from './trading-mode'
import type { BotConfig, Signal, Trade, TradingSymbol, UserBotConfig } from '@/types/trading'
import { TRADING_SYMBOLS, SYMBOL_INFO } from '@/types/trading'

// ─── Constants ────────────────────────────────────────────────────────────────

// PENDING trades older than this are stale and need reconciliation
const PENDING_STALE_MS = 5 * 60 * 1000

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface EngineResult {
  success: boolean
  message: string
  tradesOpened: number
  tradesClosed: number
  signalsGenerated: number
  errors: string[]
}

interface UserTickResult {
  userId: string
  tradesOpened: number
  tradesClosed: number
  signalsGenerated: number
  errors: string[]
}

// ─── Public Entry Point ───────────────────────────────────────────────────────

export async function runTradingTick(): Promise<EngineResult> {
  const result: EngineResult = {
    success: false,
    message: '',
    tradesOpened: 0,
    tradesClosed: 0,
    signalsGenerated: 0,
    errors: [],
  }

  try {
    const killActive = await isGlobalKillSwitchActive()
    if (killActive) {
      result.message = 'Kill switch global activo — trading suspendido'
      result.success = true
      await logSystem('WARN', '🛑 Kill switch global activo — tick abortado')
      return result
    }

    const users = await getActiveTradingUsers()
    if (users.length === 0) {
      result.message = 'No hay usuarios activos'
      result.success = true
      return result
    }

    const tickResults = await Promise.allSettled(
      users.map((u) => runTradingTickForUser(u.id)),
    )

    for (const r of tickResults) {
      if (r.status === 'fulfilled') {
        result.tradesOpened += r.value.tradesOpened
        result.tradesClosed += r.value.tradesClosed
        result.signalsGenerated += r.value.signalsGenerated
        result.errors.push(...r.value.errors)
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
        result.errors.push(msg)
        await logSystem('ERROR', `❌ Error en tick de usuario: ${msg}`)
      }
    }

    result.success = true
    result.message = `Tick completado. Abiertos: ${result.tradesOpened}, Cerrados: ${result.tradesClosed}, Señales: ${result.signalsGenerated}`
    await logSystem('INFO', `✅ ${result.message}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.message = msg
    result.errors.push(msg)
    await logSystem('ERROR', `❌ Error crítico en motor: ${msg}`)
  }

  return result
}

// ─── Per-User Tick ────────────────────────────────────────────────────────────

async function runTradingTickForUser(userId: string): Promise<UserTickResult> {
  const tickResult: UserTickResult = {
    userId,
    tradesOpened: 0,
    tradesClosed: 0,
    signalsGenerated: 0,
    errors: [],
  }

  const userConfig = await getUserBotConfig(userId)
  if (!userConfig) {
    await logUser(userId, 'WARN', '⚠️ Sin configuración de bot — tick saltado')
    return tickResult
  }

  if (!userConfig.isRunning) {
    await logUser(userId, 'INFO', '⏸️ Bot en pausa — tick saltado')
    return tickResult
  }

  if (userConfig.pausedUntil && new Date(userConfig.pausedUntil) > new Date()) {
    await logUser(userId, 'INFO', `⏸️ Bot pausado hasta ${userConfig.pausedUntil}: ${userConfig.pausedReason ?? ''}`)
    return tickResult
  }

  const client = defaultClient

  let account: Awaited<ReturnType<typeof client.getAccountInfo>>
  try {
    account = await client.getAccountInfo()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logUser(userId, 'ERROR', `❌ No se pudo obtener info de cuenta: ${msg}`)
    tickResult.errors.push(msg)
    return tickResult
  }

  const { shadowMode } = getCurrentMode()

  const allOpenTrades = await getOpenTradesForUser(userId)
  // Each mode manages only its own trades; allows shadow + real to coexist
  const openTrades = allOpenTrades.filter((t) => (t.isShadow ?? false) === shadowMode)

  // ── Resolve stale PENDING trades (real mode only) ─────────────────────────
  if (!shadowMode) {
    const pendingTrades = openTrades.filter((t) => t.status === 'PENDING')
    for (const pt of pendingTrades) {
      await resolveStalePending(pt, account.positions, userId)
    }
  }

  // Refresh open trades after resolving pending
  const activeTrades = openTrades.filter((t) => t.status === 'OPEN')

  // ── Reconcile Binance positions (real mode only) ──────────────────────────
  // Shadow trades are virtual — nothing to reconcile with Binance
  if (!shadowMode) {
    await reconcilePositions(userId, account.positions, activeTrades, userConfig, tickResult, client)
  }

  // ── Daily loss snapshot ───────────────────────────────────────────────────
  const recentTrades = await getRecentTradesForUser(userId, 200)
  // For daily loss in shadow mode, only count shadow trades
  const relevantRecent = recentTrades.filter((t) => (t.isShadow ?? false) === shadowMode)
  const dailyLoss = calculateDailyLoss(relevantRecent, shadowMode ? [] : account.positions)

  const allocatedCapital = getAllocatedCapital(account, userConfig)

  // ── Circuit breaker (escalated, replaces the old single-threshold daily pause) ─
  const closedToday = relevantRecent.filter(
    (t) => t.status === 'CLOSED' && t.closedAt &&
      new Date(t.closedAt).getTime() > Date.now() - 24 * 3600 * 1000,
  )
  const cbState = evaluateCircuitBreaker(closedToday, userConfig.maxDailyLoss, allocatedCapital)
  const modeStr = shadowMode ? '[SHADOW] ' : ''

  if (cbState.action === 'PAUSE_ALL') {
    await logUser(userId, 'WARN', `⚠️ ${modeStr}Circuit breaker PAUSE_ALL: ${cbState.reason}`)
    await pauseUserUntil(userId, cbState.pauseUntil!.toISOString(), cbState.reason)
    return tickResult
  }
  if (cbState.action !== 'NONE') {
    await logUser(userId, 'INFO', `⚠️ ${modeStr}Circuit breaker ${cbState.action}: ${cbState.reason}`)
  }

  const config = adaptConfig(userConfig, allocatedCapital)

  // Refresh after reconcile
  const freshTrades = await getOpenTradesForUser(userId)
  const freshOpen = freshTrades.filter((t) => t.status === 'OPEN' && (t.isShadow ?? false) === shadowMode)

  await logUser(userId, 'INFO', `⚙️ ${modeStr}Tick — ${userConfig.symbols.length} pares | Capital asignado: $${allocatedCapital.toFixed(2)}`)

  for (const symbol of userConfig.symbols) {
    try {
      await processSymbolForUser(symbol, userId, config, account, freshOpen, dailyLoss, shadowMode, tickResult, client, cbState)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      tickResult.errors.push(`${symbol}: ${msg}`)
      await logUser(userId, 'ERROR', `❌ Error procesando ${symbol}: ${msg}`)
    }
  }

  return tickResult
}

// ─── Stale PENDING Resolution ─────────────────────────────────────────────────

async function resolveStalePending(
  trade: Trade,
  positions: Awaited<ReturnType<typeof defaultClient.getAccountInfo>>['positions'],
  userId: string,
): Promise<void> {
  const age = Date.now() - new Date(trade.openedAt).getTime()
  if (age < PENDING_STALE_MS) return

  const binancePos = positions.find(
    (p) => p.symbol === trade.symbol && Math.abs(p.positionAmt) > 0,
  )

  if (binancePos) {
    // Binance has the position — promote to OPEN
    await updateTrade(trade.id, {
      status: 'OPEN',
      actualEntryPrice: binancePos.entryPrice,
      notes: 'PENDING promovido a OPEN por reconciliación (posición encontrada en Binance)',
    })
    await logUser(userId, 'WARN', `⚠️ PENDING ${trade.symbol} promovido a OPEN (age=${Math.round(age / 1000)}s)`)
  } else {
    // No Binance position — the entry order never filled, cancel
    await updateTrade(trade.id, {
      status: 'CANCELLED',
      closedAt: new Date().toISOString(),
      notes: 'PENDING cancelado — sin posición en Binance tras timeout',
    })
    await logUser(userId, 'WARN', `⚠️ PENDING ${trade.symbol} cancelado por timeout (age=${Math.round(age / 1000)}s)`)
  }
}

// ─── Bidirectional Reconciliation ────────────────────────────────────────────

async function reconcilePositions(
  userId: string,
  positions: Awaited<ReturnType<typeof defaultClient.getAccountInfo>>['positions'],
  openTrades: Trade[],
  config: UserBotConfig,
  result: UserTickResult,
  client: typeof defaultClient,
): Promise<void> {
  // Case B: position exists on Binance but not in DB → create + native SL
  for (const bPos of positions) {
    const symbol = bPos.symbol as TradingSymbol
    if (!TRADING_SYMBOLS.includes(symbol)) continue
    const tracked = openTrades.some((t) => t.symbol === symbol)
    if (tracked) continue

    await handleOrphanPosition(userId, bPos, config, result, client)
  }

  // Case C: trade in DB but no longer on Binance → close from userTrades history
  for (const trade of openTrades) {
    const stillOpen = positions.some(
      (p) => p.symbol === trade.symbol && Math.abs(p.positionAmt) > 0,
    )
    if (!stillOpen) {
      await closeTradeFromBinanceHistory(userId, trade, client, result)
    }
  }
}

async function handleOrphanPosition(
  userId: string,
  bPos: Awaited<ReturnType<typeof defaultClient.getAccountInfo>>['positions'][number],
  config: UserBotConfig,
  result: UserTickResult,
  client: typeof defaultClient,
): Promise<void> {
  const symbol = bPos.symbol as TradingSymbol
  const symbolInfo = SYMBOL_INFO[symbol]
  const side = bPos.positionAmt > 0 ? 'BUY' : 'SELL'
  const slSide = side === 'BUY' ? 'SELL' : 'BUY'
  const direction = side === 'BUY' ? 1 : -1
  const posQty = Math.abs(bPos.positionAmt)
  const entryPrice = bPos.entryPrice

  await logUser(userId, 'WARN', `⚠️ Posición huérfana ${symbol}: ${side} ${posQty} @ ${entryPrice}`)

  const emergencySl = roundPrice(entryPrice * (1 - direction * 0.02), symbolInfo.pricePrecision)
  const tp1Price = roundPrice(entryPrice * (1 + direction * 0.03), symbolInfo.pricePrecision)
  const tp2Price = roundPrice(entryPrice * (1 + direction * 0.05), symbolInfo.pricePrecision)

  const intentId = generateIntentId()
  const slClientId = buildClientOrderId('sl', userId, symbol, intentId)
  const tp1ClientId = buildClientOrderId('t1', userId, symbol, intentId)
  const tp2ClientId = buildClientOrderId('t2', userId, symbol, intentId)

  // Save to DB first (OPEN — we know the position exists)
  const trade = await createTrade({
    userId,
    symbol,
    side,
    status: 'OPEN',
    entryPrice,
    actualEntryPrice: entryPrice,
    quantity: posQty,
    leverage: config.leverage,
    stopLoss: emergencySl,
    takeProfit1: tp1Price,
    takeProfit2: tp2Price,
    tp1Hit: false,
    fee: entryPrice * posQty * 0.0004,
    openedAt: new Date().toISOString(),
    notes: 'Reconciliado automáticamente — registro faltaba en BD',
  })

  result.tradesOpened++

  // Place native SL
  let slOrderId: string | undefined
  try {
    const slOrder = await client.placeStopMarket({
      symbol,
      side: slSide,
      stopPrice: emergencySl,
      quantity: posQty,
      reduceOnly: true,
      clientOrderId: slClientId,
    })
    slOrderId = String(slOrder.orderId)
  } catch (e) {
    await logUser(userId, 'WARN', `⚠️ SL de emergencia no colocado en ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (slOrderId) {
    await updateTrade(trade.id, { stopOrderId: slOrderId, clientOrderId: slClientId })
  }

  // Place TP1
  const tp1Qty = roundQty(posQty * 0.5, symbolInfo.qtyPrecision)
  try {
    const tp1Order = await client.placeTakeProfitMarket({
      symbol,
      side: slSide,
      stopPrice: tp1Price,
      quantity: tp1Qty,
      reduceOnly: true,
      clientOrderId: tp1ClientId,
    })
    await updateTrade(trade.id, { tp1OrderId: String(tp1Order.orderId) })
  } catch (e) {
    await logUser(userId, 'WARN', `⚠️ TP1 huérfano no colocado en ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Place TP2
  const tp2Qty = roundQty(posQty * 0.5, symbolInfo.qtyPrecision)
  try {
    const tp2Order = await client.placeTakeProfitMarket({
      symbol,
      side: slSide,
      stopPrice: tp2Price,
      quantity: tp2Qty,
      reduceOnly: true,
      clientOrderId: tp2ClientId,
    })
    await updateTrade(trade.id, { tp2OrderId: String(tp2Order.orderId) })
  } catch (e) {
    await logUser(userId, 'WARN', `⚠️ TP2 huérfano no colocado en ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function closeTradeFromBinanceHistory(
  userId: string,
  trade: Trade,
  client: typeof defaultClient,
  result: UserTickResult,
): Promise<void> {
  let exitPrice = 0
  let realizedPnl = 0
  let totalFee = trade.fee

  try {
    const fills = await client.getUserTrades(trade.symbol, {
      startTime: new Date(trade.openedAt).getTime(),
      limit: 50,
    })

    // Only fills that came after trade open and are closing side
    const closingSide = trade.side === 'BUY' ? 'SELL' : 'BUY'
    const closingFills = fills.filter((f) => f.side === closingSide)

    if (closingFills.length > 0) {
      const totalQty = closingFills.reduce((s, f) => s + f.qty, 0)
      exitPrice = closingFills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty
      realizedPnl = closingFills.reduce((s, f) => s + f.realizedPnl, 0)
      totalFee += closingFills.reduce((s, f) => s + f.commission, 0)
    }
  } catch (e) {
    await logUser(userId, 'WARN', `⚠️ No se pudieron obtener fills para ${trade.symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Fall back to estimated PnL if no fills found
  const direction = trade.side === 'BUY' ? 1 : -1
  const effectiveExit = exitPrice || trade.stopLoss
  const pnl = realizedPnl !== 0
    ? realizedPnl - totalFee
    : (effectiveExit - trade.entryPrice) * direction * trade.quantity - totalFee
  const pnlPct = ((effectiveExit - trade.entryPrice) / trade.entryPrice) * direction * trade.leverage * 100
  const duration = Date.now() - new Date(trade.openedAt).getTime()

  await updateTrade(trade.id, {
    status: 'CLOSED',
    exitPrice: effectiveExit,
    actualExitPrice: exitPrice || undefined,
    pnl,
    pnlPct,
    fee: totalFee,
    duration,
    closedAt: new Date().toISOString(),
    realizedPnlBinance: realizedPnl !== 0 ? realizedPnl : undefined,
    notes: 'Cerrado por TP/SL en Binance',
  })

  result.tradesClosed++
  await logUser(userId, 'TRADE', `🏁 ${trade.symbol} cerrado por Binance | P&L: $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`, {
    tradeId: trade.id, pnl, pnlPct,
  })
}

// ─── Symbol Processing ────────────────────────────────────────────────────────

async function processSymbolForUser(
  symbol: TradingSymbol,
  userId: string,
  config: BotConfig,
  account: Awaited<ReturnType<typeof defaultClient.getAccountInfo>>,
  openTrades: Trade[],
  dailyLoss: DailyLossSnapshot,
  shadowMode: boolean,
  result: UserTickResult,
  client: typeof defaultClient,
  cbState: CircuitBreakerState,
): Promise<void> {
  const [candles1h, candles4h] = await Promise.all([
    client.getKlines(symbol, '1h', 250),
    client.getKlines(symbol, '4h', 250),
  ])

  const currentPrice = candles1h[candles1h.length - 1].close

  const existingTrade = openTrades.find((t) => t.symbol === symbol && t.status === 'OPEN')
  if (existingTrade) {
    const closed = shadowMode
      ? await manageShadowPosition(existingTrade, currentPrice, candles1h, userId)
      : await manageOpenPosition(existingTrade, currentPrice, candles1h, config, account.positions, userId, client)
    if (closed) result.tradesClosed++
    return
  }

  const traceEnabled = process.env.SIGNAL_TRACE_ENABLED !== 'false'
  const signal = await generateSignal({
    symbol, candles1h, candles4h, currentPrice,
    slAtrMult: config.slAtrMult,
    tp1AtrMult: config.tp1AtrMult,
    tp2AtrMult: config.tp2AtrMult,
    userId,
    traceEnabled,
  })
  if (!signal) return

  // ── Circuit breaker: directional pause ────────────────────────────────────
  if (
    cbState.action === 'PAUSE_DIRECTION' &&
    cbState.pausedDirection &&
    cbState.pauseUntil &&
    new Date() < cbState.pauseUntil &&
    signal.type === cbState.pausedDirection
  ) {
    await logUser(userId, 'INFO',
      `⏸️ ${signal.type} bloqueado por circuit breaker en ${symbol} hasta ${cbState.pauseUntil.toISOString()}`)
    return
  }

  result.signalsGenerated++
  await saveSignal(signal)
  await logUser(userId, 'INFO', `📊 Señal ${signal.type} en ${symbol} | Strength: ${signal.strength}% | Precio: ${currentPrice}`)

  const riskCheck = checkCanOpenPosition(signal, openTrades, account, config, dailyLoss)
  if (!riskCheck.allowed) {
    await logUser(userId, 'WARN', `⛔ Señal rechazada en ${symbol}: ${riskCheck.reason}`)
    return
  }

  const side = signal.type === 'LONG' ? 'BUY' : 'SELL'
  if (!validateRiskReward(currentPrice, signal.stopLoss, signal.takeProfit1, side, 1.5)) {
    await logUser(userId, 'WARN', `⛔ R:R insuficiente en ${symbol}, señal descartada`)
    return
  }

  await openPositionForUser(symbol, userId, signal, config, shadowMode, result, client, cbState.sizeMultiplier)
}

// ─── Open Position ────────────────────────────────────────────────────────────

async function openPositionForUser(
  symbol: TradingSymbol,
  userId: string,
  signal: Signal,
  config: BotConfig,
  shadowMode: boolean,
  result: UserTickResult,
  client: typeof defaultClient,
  sizeMultiplier = 1.0,
): Promise<void> {
  const symbolInfo = SYMBOL_INFO[symbol]
  const side = signal.type === 'LONG' ? 'BUY' : 'SELL'
  const slSide = side === 'BUY' ? 'SELL' : 'BUY'
  const leverage = config.leverage

  // Step 1: set leverage / margin type (real mode only)
  if (!shadowMode) {
    try { await client.setLeverage(symbol, leverage) } catch (e) {
      await logUser(userId, 'WARN', `⚠️ setLeverage ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    }
    try { await client.setMarginType(symbol, 'ISOLATED') } catch (e) {
      await logUser(userId, 'WARN', `⚠️ setMarginType ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Step 2: position size (sizeMultiplier < 1.0 when circuit breaker is active)
  const ps = calculatePositionSize(
    config.currentCapital,
    config.riskPerTrade * sizeMultiplier,
    signal.price,
    signal.stopLoss,
    leverage,
    symbolInfo.qtyPrecision,
  )

  if (ps.quantity < symbolInfo.minQty) {
    await logUser(userId, 'WARN', `⛔ Qty muy pequeña en ${symbol}: ${ps.quantity} < ${symbolInfo.minQty}`)
    return
  }

  const slPrice = roundPrice(signal.stopLoss, symbolInfo.pricePrecision)
  const tp1Price = roundPrice(signal.takeProfit1, symbolInfo.pricePrecision)
  const tp2Price = roundPrice(signal.takeProfit2, symbolInfo.pricePrecision)

  // Step 3: generate idempotent IDs
  const intentId = generateIntentId()
  const entryClientId = buildClientOrderId('en', userId, symbol, intentId)
  const slClientId = buildClientOrderId('sl', userId, symbol, intentId)
  const tp1ClientId = buildClientOrderId('t1', userId, symbol, intentId)
  const tp2ClientId = buildClientOrderId('t2', userId, symbol, intentId)

  // ── SHADOW MODE branch ────────────────────────────────────────────────────
  if (shadowMode) {
    const simulatedFee = signal.price * ps.quantity * 0.0004
    const trade = await createTrade({
      userId,
      symbol,
      side,
      status: 'OPEN',
      isShadow: true,
      entryPrice: signal.price,
      actualEntryPrice: signal.price,
      quantity: ps.quantity,
      leverage,
      stopLoss: slPrice,
      takeProfit1: tp1Price,
      takeProfit2: tp2Price,
      tp1Hit: false,
      fee: simulatedFee,
      binanceOrderId: `shadow-${intentId}`,
      stopOrderId: `shadow-sl-${intentId}`,
      tp1OrderId: `shadow-tp1-${intentId}`,
      tp2OrderId: `shadow-tp2-${intentId}`,
      clientOrderId: entryClientId,
      openedAt: new Date().toISOString(),
    })
    result.tradesOpened++
    await logUser(userId, 'TRADE', `[SHADOW] ✅ ENTRADA ${side} ${symbol} | Qty: ${ps.quantity} | Entry: ${signal.price} | SL: ${slPrice} | TP1: ${tp1Price} | TP2: ${tp2Price} | Riesgo: $${ps.riskAmount.toFixed(2)}`, {
      tradeId: trade.id, symbol, side, quantity: ps.quantity, entryPrice: signal.price, stopLoss: slPrice,
    })
    return
  }

  // ── REAL MODE: Steps 4-9 ─────────────────────────────────────────────────

  // Step 4: save PENDING trade before placing order (crash safety)
  const trade = await createTrade({
    userId,
    symbol,
    side,
    status: 'PENDING',
    isShadow: false,
    entryPrice: signal.price,
    quantity: ps.quantity,
    leverage,
    stopLoss: slPrice,
    takeProfit1: tp1Price,
    takeProfit2: tp2Price,
    tp1Hit: false,
    fee: ps.positionValue * 0.0004,
    clientOrderId: entryClientId,
    openedAt: new Date().toISOString(),
  })

  // Step 5: place entry order
  let entryOrderId: string
  try {
    const entryOrder = await client.placeOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity: ps.quantity,
      clientOrderId: entryClientId,
    })
    entryOrderId = String(entryOrder.orderId)
  } catch (err) {
    // Entry failed — cancel the PENDING record
    await updateTrade(trade.id, {
      status: 'CANCELLED',
      closedAt: new Date().toISOString(),
      notes: `Entrada fallida: ${err instanceof Error ? err.message : String(err)}`,
    })
    await logUser(userId, 'ERROR', `❌ Entrada fallida en ${symbol}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  // Step 6: get actual fill price from userTrades
  let actualEntryPrice = signal.price
  try {
    await new Promise((r) => setTimeout(r, 500)) // brief wait for fill to appear
    const fills = await client.getUserTrades(symbol, { limit: 5 })
    const myFills = fills.filter((f) => String(f.orderId) === entryOrderId && f.side === side)
    if (myFills.length > 0) {
      const totalQty = myFills.reduce((s, f) => s + f.qty, 0)
      actualEntryPrice = myFills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty
    }
  } catch {
    // non-fatal — use signal price
  }

  // Step 7: promote to OPEN with actual entry price
  await updateTrade(trade.id, {
    status: 'OPEN',
    binanceOrderId: entryOrderId,
    actualEntryPrice,
  })

  result.tradesOpened++

  // Step 8: place native SL
  let slOrderId: string | undefined
  try {
    const slOrder = await client.placeStopMarket({
      symbol,
      side: slSide,
      stopPrice: slPrice,
      quantity: ps.quantity,
      reduceOnly: true,
      clientOrderId: slClientId,
    })
    slOrderId = String(slOrder.orderId)
    await updateTrade(trade.id, { stopOrderId: slOrderId })
  } catch (e) {
    await logUser(userId, 'WARN', `⚠️ SL nativo no colocado en ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    // Emergency close if SL fails
    try {
      await client.placeOrder({ symbol, side: slSide, type: 'MARKET', quantity: ps.quantity, reduceOnly: true })
      await updateTrade(trade.id, {
        status: 'CANCELLED',
        closedAt: new Date().toISOString(),
        notes: 'Posición cerrada de emergencia — fallo al colocar SL',
      })
      await logUser(userId, 'ERROR', `🚨 Posición ${symbol} cerrada de emergencia por fallo de SL`)
    } catch (e2) {
      await logUser(userId, 'ERROR', `🚨 CIERRE DE EMERGENCIA FALLIDO en ${symbol}: ${e2 instanceof Error ? e2.message : String(e2)}`)
    }
    return
  }

  // Step 9: place TP1 and TP2
  const tp1Qty = roundQty(ps.quantity * 0.5, symbolInfo.qtyPrecision)
  const tp2Qty = roundQty(ps.quantity - tp1Qty, symbolInfo.qtyPrecision)

  try {
    const tp1Order = await client.placeTakeProfitMarket({
      symbol, side: slSide, stopPrice: tp1Price,
      quantity: tp1Qty, reduceOnly: true, clientOrderId: tp1ClientId,
    })
    await updateTrade(trade.id, { tp1OrderId: String(tp1Order.orderId) })
  } catch (e) {
    await logUser(userId, 'WARN', `⚠️ TP1 no colocado en ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const tp2Order = await client.placeTakeProfitMarket({
      symbol, side: slSide, stopPrice: tp2Price,
      quantity: tp2Qty, reduceOnly: true, clientOrderId: tp2ClientId,
    })
    await updateTrade(trade.id, { tp2OrderId: String(tp2Order.orderId) })
  } catch (e) {
    await logUser(userId, 'WARN', `⚠️ TP2 no colocado en ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }

  await logUser(userId, 'TRADE', `✅ ENTRADA ${side} ${symbol} | Qty: ${ps.quantity} | Precio: ${actualEntryPrice} | SL: ${slPrice} | TP1: ${tp1Price} | TP2: ${tp2Price} | Riesgo: $${ps.riskAmount.toFixed(2)}`, {
    tradeId: trade.id, symbol, side, quantity: ps.quantity, entryPrice: actualEntryPrice, stopLoss: slPrice,
  })
}

// ─── Manage Open Position ─────────────────────────────────────────────────────

async function manageOpenPosition(
  trade: Trade,
  currentPrice: number,
  candles1h: Awaited<ReturnType<typeof defaultClient.getKlines>>,
  config: BotConfig,
  positions: Awaited<ReturnType<typeof defaultClient.getAccountInfo>>['positions'],
  userId: string,
  client: typeof defaultClient,
): Promise<boolean> {
  const symbolInfo = SYMBOL_INFO[trade.symbol]
  const direction = trade.side === 'BUY' ? 1 : -1
  const slSide = trade.side === 'BUY' ? 'SELL' : 'BUY'

  const stillOpenOnBinance = positions.some(
    (p) => p.symbol === trade.symbol && Math.abs(p.positionAmt) > 0,
  )

  // Position was closed by TP/SL on Binance — handled by Case C in next reconcile tick
  if (!stillOpenOnBinance) {
    // Handled by reconcilePositions Case C — skip here to avoid double-close
    return false
  }

  // ── Check TP1 via order status ────────────────────────────────────────────
  if (trade.tp1OrderId && !trade.tp1Hit) {
    try {
      const tp1Status = await client.getOrderStatus(trade.symbol, parseInt(trade.tp1OrderId))
      if (tp1Status === 'FILLED') {
        await updateTrade(trade.id, { tp1Hit: true })
        await logUser(userId, 'TRADE', `🎯 TP1 alcanzado en ${trade.symbol} @ ${currentPrice}`)

        // Move SL to break-even
        const beSl = roundPrice(trade.entryPrice * (1 + direction * 0.001), symbolInfo.pricePrecision)
        const intentId = generateIntentId()
        const newSlClientId = buildClientOrderId('sl', userId, trade.symbol, intentId)
        try {
          const newSlOrder = await client.replaceStopLoss(trade.symbol, trade.stopOrderId ?? null, {
            symbol: trade.symbol,
            side: slSide,
            stopPrice: beSl,
            quantity: trade.quantity,
            reduceOnly: true,
            clientOrderId: newSlClientId,
          })
          await updateTrade(trade.id, { stopLoss: beSl, stopOrderId: String(newSlOrder.orderId) })
          await logUser(userId, 'INFO', `🔒 SL movido a break-even ${trade.symbol}: ${beSl}`)
        } catch (e) {
          await logUser(userId, 'WARN', `⚠️ No se pudo mover SL a BE en ${trade.symbol}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch {
      // non-fatal
    }
  }

  // ── Trailing stop after TP1 ───────────────────────────────────────────────
  if (trade.tp1Hit && candles1h.length >= 210) {
    const ind = calculateIndicators(candles1h)
    const newSl = calculateTrailingStop(trade, currentPrice, ind.atr14)

    if (newSl !== null) {
      const roundedSl = roundPrice(newSl, symbolInfo.pricePrecision)
      const intentId = generateIntentId()
      const newSlClientId = buildClientOrderId('sl', userId, trade.symbol, intentId)
      try {
        const newSlOrder = await client.replaceStopLoss(trade.symbol, trade.stopOrderId ?? null, {
          symbol: trade.symbol,
          side: slSide,
          stopPrice: roundedSl,
          quantity: trade.quantity,
          reduceOnly: true,
          clientOrderId: newSlClientId,
        })
        await updateTrade(trade.id, { stopLoss: roundedSl, stopOrderId: String(newSlOrder.orderId) })
        await logUser(userId, 'INFO', `🔄 Trailing stop actualizado ${trade.symbol}: ${roundedSl}`)
      } catch (e) {
        await logUser(userId, 'WARN', `⚠️ Trailing stop fallido en ${trade.symbol}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // ── Early exit check ──────────────────────────────────────────────────────
  if (candles1h.length >= 210) {
    const closeEarly = shouldCloseEarly(trade.side, candles1h, currentPrice, trade.entryPrice)
    if (closeEarly) {
      await closePositionEarly(trade, currentPrice, userId, 'Señal de cierre anticipado (reversión de tendencia)', client)
      return true
    }
  }

  return false
}

// ─── Close Position Early ─────────────────────────────────────────────────────

async function closePositionEarly(
  trade: Trade,
  currentPrice: number,
  userId: string,
  reason: string,
  client: typeof defaultClient,
): Promise<void> {
  const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const direction = trade.side === 'BUY' ? 1 : -1

  // Cancel all open orders for this symbol
  try {
    await client.cancelAllOrders(trade.symbol)
  } catch (e) {
    await logUser(userId, 'WARN', `⚠️ cancelAllOrders ${trade.symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Place market close
  let closeOrderId: string | undefined
  try {
    const closeOrder = await client.placeOrder({
      symbol: trade.symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: trade.quantity,
      reduceOnly: true,
    })
    closeOrderId = String(closeOrder.orderId)
  } catch (err) {
    await logUser(userId, 'ERROR', `❌ Fallo al cerrar posición ${trade.symbol}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  // Get PnL from userTrades
  let actualExitPrice = currentPrice
  let realizedPnl = 0
  let totalFee = trade.fee

  try {
    await new Promise((r) => setTimeout(r, 500))
    const fills = await client.getUserTrades(trade.symbol, { limit: 5 })
    const myFills = fills.filter((f) => closeOrderId && String(f.orderId) === closeOrderId)
    if (myFills.length > 0) {
      const totalQty = myFills.reduce((s, f) => s + f.qty, 0)
      actualExitPrice = myFills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty
      realizedPnl = myFills.reduce((s, f) => s + f.realizedPnl, 0)
      totalFee += myFills.reduce((s, f) => s + f.commission, 0)
    }
  } catch {
    // non-fatal
  }

  const pnl = realizedPnl !== 0
    ? realizedPnl - totalFee
    : (actualExitPrice - trade.entryPrice) * direction * trade.quantity - totalFee
  const pnlPct = ((actualExitPrice - trade.entryPrice) / trade.entryPrice) * direction * trade.leverage * 100
  const duration = Date.now() - new Date(trade.openedAt).getTime()

  await updateTrade(trade.id, {
    status: 'CLOSED',
    exitPrice: actualExitPrice,
    actualExitPrice,
    pnl,
    pnlPct,
    fee: totalFee,
    duration,
    closedAt: new Date().toISOString(),
    realizedPnlBinance: realizedPnl !== 0 ? realizedPnl : undefined,
    notes: reason,
  })

  await logUser(userId, 'TRADE', `🔴 CIERRE ${trade.symbol} | P&L: $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) | ${reason}`, {
    tradeId: trade.id, pnl, pnlPct,
  })
}

// ─── Shadow Position Management ──────────────────────────────────────────────

async function manageShadowPosition(
  trade: Trade,
  currentPrice: number,
  candles1h: Awaited<ReturnType<typeof defaultClient.getKlines>>,
  userId: string,
): Promise<boolean> {
  const symbolInfo = SYMBOL_INFO[trade.symbol]
  const direction = trade.side === 'BUY' ? 1 : -1

  // 1. SL hit check
  const slHit = trade.side === 'BUY'
    ? currentPrice <= trade.stopLoss
    : currentPrice >= trade.stopLoss

  if (slHit) {
    await closeShadowPosition(userId, trade, trade.stopLoss, 'Stop Loss simulado')
    return true
  }

  // 2. TP1 check
  if (!trade.tp1Hit) {
    const tp1Hit = trade.side === 'BUY'
      ? currentPrice >= trade.takeProfit1
      : currentPrice <= trade.takeProfit1

    if (tp1Hit) {
      const partialQty = trade.quantity * 0.5
      const partialPnl = (trade.takeProfit1 - trade.entryPrice) * direction * partialQty
      const partialFee = trade.takeProfit1 * partialQty * 0.0004
      const beSl = roundPrice(trade.entryPrice * (1 + direction * 0.001), symbolInfo.pricePrecision)

      await updateTrade(trade.id, {
        tp1Hit: true,
        stopLoss: beSl,
        fee: trade.fee + partialFee,
        notes: `${trade.notes ?? ''} | [SHADOW] TP1 @ ${trade.takeProfit1}, partial PnL: +${partialPnl.toFixed(2)}`.trim(),
      })
      await logUser(userId, 'TRADE', `[SHADOW] 🎯 TP1 simulado ${trade.symbol} @ ${trade.takeProfit1} | SL movido a BE: ${beSl}`)
    }
  }

  // 3. TP2 check (only after TP1)
  if (trade.tp1Hit) {
    const tp2Hit = trade.side === 'BUY'
      ? currentPrice >= trade.takeProfit2
      : currentPrice <= trade.takeProfit2

    if (tp2Hit) {
      await closeShadowPosition(userId, trade, trade.takeProfit2, 'Take Profit 2 simulado')
      return true
    }

    // 4. Trailing stop (only after TP1)
    if (candles1h.length >= 210) {
      const ind = calculateIndicators(candles1h)
      const newSl = calculateTrailingStop(trade, currentPrice, ind.atr14)
      if (newSl !== null) {
        const roundedSl = roundPrice(newSl, symbolInfo.pricePrecision)
        if (Math.abs(roundedSl - trade.stopLoss) / trade.stopLoss > 0.001) {
          await updateTrade(trade.id, { stopLoss: roundedSl })
          await logUser(userId, 'INFO', `[SHADOW] 🔄 Trailing stop ${trade.symbol}: ${roundedSl}`)
        }
      }
    }
  }

  // 5. Early exit check
  if (candles1h.length >= 210) {
    if (shouldCloseEarly(trade.side, candles1h, currentPrice, trade.entryPrice)) {
      await closeShadowPosition(userId, trade, currentPrice, 'Cierre anticipado simulado (reversión)')
      return true
    }
  }

  return false
}

async function closeShadowPosition(
  userId: string,
  trade: Trade,
  exitPrice: number,
  reason: string,
): Promise<void> {
  const direction = trade.side === 'BUY' ? 1 : -1
  const remainingQty = trade.tp1Hit ? trade.quantity * 0.5 : trade.quantity

  let totalPnl: number
  if (trade.tp1Hit) {
    const partialPnl = (trade.takeProfit1 - trade.entryPrice) * direction * (trade.quantity * 0.5)
    const remainingPnl = (exitPrice - trade.entryPrice) * direction * (trade.quantity * 0.5)
    totalPnl = partialPnl + remainingPnl
  } else {
    totalPnl = (exitPrice - trade.entryPrice) * direction * trade.quantity
  }

  const closeFee = exitPrice * remainingQty * 0.0004
  const totalFee = trade.fee + closeFee
  const netPnl = totalPnl - totalFee
  const margin = trade.entryPrice * trade.quantity / trade.leverage
  const pnlPct = margin > 0 ? (netPnl / margin) * 100 : 0
  const duration = Date.now() - new Date(trade.openedAt).getTime()

  await updateTrade(trade.id, {
    status: 'CLOSED',
    exitPrice,
    actualExitPrice: exitPrice,
    realizedPnlBinance: totalPnl,
    pnl: netPnl,
    pnlPct,
    fee: totalFee,
    duration,
    closedAt: new Date().toISOString(),
    notes: `[SHADOW] ${reason}`,
  })

  await logUser(userId, 'TRADE', `[SHADOW] 🔴 CIERRE ${trade.symbol} @ ${exitPrice} | PnL: $${netPnl.toFixed(2)} (${pnlPct.toFixed(2)}%) | ${reason}`, {
    tradeId: trade.id, pnl: netPnl, pnlPct,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAllocatedCapital(
  account: Awaited<ReturnType<typeof defaultClient.getAccountInfo>>,
  config: UserBotConfig,
): number {
  // B7 fix: use totalBalance (wallet only), not totalMarginBalance + unrealizedPnl
  return account.totalBalance * config.tradingAllocationPct
}

function adaptConfig(config: UserBotConfig, allocatedCapital: number): BotConfig {
  return {
    isRunning: config.isRunning,
    symbols: config.symbols,
    leverage: config.leverage,
    riskPerTrade: config.riskPerTrade,
    maxPositions: config.maxPositions,
    maxDailyLoss: config.maxDailyLoss,
    initialCapital: allocatedCapital,
    currentCapital: allocatedCapital,
    marginType: config.marginType,
    strategy: config.strategy,
    timeframe: config.timeframe,
    slAtrMult: config.slAtrMult,
    tp1AtrMult: config.tp1AtrMult,
    tp2AtrMult: config.tp2AtrMult,
  }
}

async function logUser(
  userId: string,
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'TRADE',
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const ts = new Date().toISOString()
  console.log(`[${level}][${userId.slice(0, 8)}] ${message}`)
  await addLogForUser(userId, { level, message, data, timestamp: ts })
}

async function logSystem(
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await logUser(SYSTEM_USER_ID, level, message, data)
}

