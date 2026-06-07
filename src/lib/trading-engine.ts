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
  type DailyLossSnapshot,
} from './strategy/risk'
import { calculateIndicators } from './strategy/indicators'
import { saveSignal, supabaseAdmin } from './supabase'
import type { BotConfig, Signal, Trade, TradingSymbol, UserBotConfig } from '@/types/trading'
import { TRADING_SYMBOLS, SYMBOL_INFO } from '@/types/trading'

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || '00000000-0000-0000-0000-000000000001'

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

  const openTrades = await getOpenTradesForUser(userId)

  // ── Resolve stale PENDING trades ──────────────────────────────────────────
  const pendingTrades = openTrades.filter((t) => t.status === 'PENDING')
  for (const pt of pendingTrades) {
    await resolveStalePending(pt, account.positions, userId)
  }

  // Refresh open trades after resolving pending
  const activeTrades = openTrades.filter((t) => t.status === 'OPEN')

  // ── Reconcile Binance positions ───────────────────────────────────────────
  await reconcilePositions(userId, account.positions, activeTrades, userConfig, tickResult, client)

  // ── Daily loss snapshot ───────────────────────────────────────────────────
  const recentTrades = await getRecentTradesForUser(userId, 200)
  const dailyLoss = calculateDailyLoss(recentTrades, account.positions)

  const allocatedCapital = getAllocatedCapital(account, userConfig)
  const dailyLossThreshold = allocatedCapital * userConfig.maxDailyLoss

  if (dailyLoss.totalLoss >= dailyLossThreshold) {
    await logUser(userId, 'WARN', `⚠️ Límite pérdida diaria: ${(dailyLoss.totalLoss).toFixed(2)} >= ${dailyLossThreshold.toFixed(2)}. Pausando 24h.`)
    await pauseUserUntil(userId, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), 'Límite de pérdida diaria alcanzado')
    return tickResult
  }

  const config = adaptConfig(userConfig, allocatedCapital)

  // Refresh after reconcile
  const freshTrades = await getOpenTradesForUser(userId)
  const freshOpen = freshTrades.filter((t) => t.status === 'OPEN')

  await logUser(userId, 'INFO', `⚙️ Tick — ${userConfig.symbols.length} pares | Capital asignado: $${allocatedCapital.toFixed(2)}`)

  for (const symbol of userConfig.symbols) {
    try {
      await processSymbolForUser(symbol, userId, config, account, freshOpen, dailyLoss, tickResult, client)
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
    await updateTradeRecord(trade.id, {
      status: 'OPEN',
      actualEntryPrice: binancePos.entryPrice,
      notes: 'PENDING promovido a OPEN por reconciliación (posición encontrada en Binance)',
    })
    await logUser(userId, 'WARN', `⚠️ PENDING ${trade.symbol} promovido a OPEN (age=${Math.round(age / 1000)}s)`)
  } else {
    // No Binance position — the entry order never filled, cancel
    await updateTradeRecord(trade.id, {
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
  const trade = await createTradeRecord({
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
    await updateTradeRecord(trade.id, { stopOrderId: slOrderId, clientOrderId: slClientId })
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
    await updateTradeRecord(trade.id, { tp1OrderId: String(tp1Order.orderId) })
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
    await updateTradeRecord(trade.id, { tp2OrderId: String(tp2Order.orderId) })
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

  await updateTradeRecord(trade.id, {
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
  result: UserTickResult,
  client: typeof defaultClient,
): Promise<void> {
  const [candles1h, candles4h] = await Promise.all([
    client.getKlines(symbol, '1h', 250),
    client.getKlines(symbol, '4h', 250),
  ])

  const currentPrice = candles1h[candles1h.length - 1].close

  const existingTrade = openTrades.find((t) => t.symbol === symbol && t.status === 'OPEN')
  if (existingTrade) {
    const closed = await manageOpenPosition(existingTrade, currentPrice, candles1h, config, account.positions, userId, client)
    if (closed) result.tradesClosed++
    return
  }

  const signal = await generateSignal({ symbol, candles1h, candles4h, currentPrice })
  if (!signal) return

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

  await openPositionForUser(symbol, userId, signal, config, result, client)
}

// ─── Open Position ────────────────────────────────────────────────────────────

async function openPositionForUser(
  symbol: TradingSymbol,
  userId: string,
  signal: Signal,
  config: BotConfig,
  result: UserTickResult,
  client: typeof defaultClient,
): Promise<void> {
  const symbolInfo = SYMBOL_INFO[symbol]
  const side = signal.type === 'LONG' ? 'BUY' : 'SELL'
  const slSide = side === 'BUY' ? 'SELL' : 'BUY'
  const leverage = config.leverage

  // Step 1: set leverage / margin type (non-fatal)
  try { await client.setLeverage(symbol, leverage) } catch (e) {
    await logUser(userId, 'WARN', `⚠️ setLeverage ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }
  try { await client.setMarginType(symbol, 'ISOLATED') } catch (e) {
    await logUser(userId, 'WARN', `⚠️ setMarginType ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Step 2: position size
  const ps = calculatePositionSize(
    config.currentCapital,
    config.riskPerTrade,
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

  // Step 4: save PENDING trade before placing order (crash safety)
  const trade = await createTradeRecord({
    userId,
    symbol,
    side,
    status: 'PENDING',
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
    await updateTradeRecord(trade.id, {
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
  await updateTradeRecord(trade.id, {
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
    await updateTradeRecord(trade.id, { stopOrderId: slOrderId })
  } catch (e) {
    await logUser(userId, 'WARN', `⚠️ SL nativo no colocado en ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    // Emergency close if SL fails
    try {
      await client.placeOrder({ symbol, side: slSide, type: 'MARKET', quantity: ps.quantity, reduceOnly: true })
      await updateTradeRecord(trade.id, {
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
    await updateTradeRecord(trade.id, { tp1OrderId: String(tp1Order.orderId) })
  } catch (e) {
    await logUser(userId, 'WARN', `⚠️ TP1 no colocado en ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const tp2Order = await client.placeTakeProfitMarket({
      symbol, side: slSide, stopPrice: tp2Price,
      quantity: tp2Qty, reduceOnly: true, clientOrderId: tp2ClientId,
    })
    await updateTradeRecord(trade.id, { tp2OrderId: String(tp2Order.orderId) })
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
        await updateTradeRecord(trade.id, { tp1Hit: true })
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
          await updateTradeRecord(trade.id, { stopLoss: beSl, stopOrderId: String(newSlOrder.orderId) })
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
        await updateTradeRecord(trade.id, { stopLoss: roundedSl, stopOrderId: String(newSlOrder.orderId) })
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

  await updateTradeRecord(trade.id, {
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

// ─── Inline Data Layer ────────────────────────────────────────────────────────
// These functions will be moved to supabase.ts in Section 8.

async function isGlobalKillSwitchActive(): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin
      .from('global_kill_switch')
      .select('is_active')
      .order('activated_at', { ascending: false })
      .limit(1)
      .single()
    return data?.is_active === true
  } catch {
    return false
  }
}

async function getActiveTradingUsers(): Promise<{ id: string }[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_bot_config')
      .select('user_id')
      .eq('is_running', true)
    if (error || !data || data.length === 0) {
      return [{ id: SYSTEM_USER_ID }]
    }
    return data.map((r) => ({ id: r.user_id as string }))
  } catch {
    return [{ id: SYSTEM_USER_ID }]
  }
}

async function getUserBotConfig(userId: string): Promise<UserBotConfig | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_bot_config')
      .select('*')
      .eq('user_id', userId)
      .single()
    if (error || !data) return null
    return {
      userId: data.user_id as string,
      isRunning: data.is_running as boolean,
      symbols: (data.symbols as string[]) as UserBotConfig['symbols'],
      leverage: data.leverage as number,
      riskPerTrade: data.risk_per_trade as number,
      maxPositions: data.max_positions as number,
      maxDailyLoss: data.max_daily_loss as number,
      tradingAllocationPct: (data.trading_allocation_pct as number) ?? 1.0,
      marginType: 'ISOLATED',
      strategy: data.strategy as string,
      timeframe: data.timeframe as string,
      minSignalStrength: (data.min_signal_strength as number) ?? 60,
      pausedUntil: data.paused_until as string | undefined,
      pausedReason: data.paused_reason as string | undefined,
      updatedAt: data.updated_at as string,
    }
  } catch {
    return null
  }
}

async function getOpenTradesForUser(userId: string): Promise<Trade[]> {
  const { data, error } = await supabaseAdmin
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['OPEN', 'PENDING'])
    .order('opened_at', { ascending: false })
  if (error) throw error
  return (data || []).map(mapTradeRow)
}

async function getRecentTradesForUser(userId: string, limit: number): Promise<Trade[]> {
  const { data, error } = await supabaseAdmin
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .order('opened_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data || []).map(mapTradeRow)
}

async function pauseUserUntil(userId: string, until: string, reason: string): Promise<void> {
  await supabaseAdmin
    .from('user_bot_config')
    .update({ paused_until: until, paused_reason: reason, is_running: false })
    .eq('user_id', userId)
}

async function createTradeRecord(trade: Omit<Trade, 'id'> & { userId: string }): Promise<Trade> {
  const { data, error } = await supabaseAdmin
    .from('trades')
    .insert(mapTradeRowToDb(trade))
    .select()
    .single()
  if (error) throw error
  return mapTradeRow(data)
}

async function updateTradeRecord(id: string, updates: Partial<Trade> & { userId?: string }): Promise<void> {
  const { error } = await supabaseAdmin
    .from('trades')
    .update(mapTradeRowToDb(updates))
    .eq('id', id)
  if (error) throw error
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function mapTradeRow(row: Record<string, unknown>): Trade {
  return {
    id: row.id as string,
    symbol: row.symbol as Trade['symbol'],
    side: row.side as Trade['side'],
    status: row.status as Trade['status'],
    entryPrice: row.entry_price as number,
    exitPrice: row.exit_price as number | undefined,
    quantity: row.quantity as number,
    leverage: row.leverage as number,
    stopLoss: row.stop_loss as number,
    takeProfit1: row.take_profit1 as number,
    takeProfit2: row.take_profit2 as number,
    tp1Hit: row.tp1_hit as boolean,
    pnl: row.pnl as number | undefined,
    pnlPct: row.pnl_pct as number | undefined,
    fee: (row.fee as number) ?? 0,
    duration: row.duration as number | undefined,
    binanceOrderId: row.binance_order_id as string | undefined,
    stopOrderId: row.stop_order_id as string | undefined,
    tp1OrderId: row.tp1_order_id as string | undefined,
    tp2OrderId: row.tp2_order_id as string | undefined,
    openedAt: row.opened_at as string,
    closedAt: row.closed_at as string | undefined,
    notes: row.notes as string | undefined,
    userId: row.user_id as string | undefined,
    clientOrderId: row.client_order_id as string | undefined,
    actualEntryPrice: row.actual_entry_price as number | undefined,
    actualExitPrice: row.actual_exit_price as number | undefined,
    realizedPnlBinance: row.realized_pnl_binance as number | undefined,
  }
}

function mapTradeRowToDb(trade: Partial<Trade> & { userId?: string }): Record<string, unknown> {
  const db: Record<string, unknown> = {}
  if (trade.userId !== undefined) db.user_id = trade.userId
  if (trade.symbol !== undefined) db.symbol = trade.symbol
  if (trade.side !== undefined) db.side = trade.side
  if (trade.status !== undefined) db.status = trade.status
  if (trade.entryPrice !== undefined) db.entry_price = trade.entryPrice
  if (trade.exitPrice !== undefined) db.exit_price = trade.exitPrice
  if (trade.quantity !== undefined) db.quantity = trade.quantity
  if (trade.leverage !== undefined) db.leverage = trade.leverage
  if (trade.stopLoss !== undefined) db.stop_loss = trade.stopLoss
  if (trade.takeProfit1 !== undefined) db.take_profit1 = trade.takeProfit1
  if (trade.takeProfit2 !== undefined) db.take_profit2 = trade.takeProfit2
  if (trade.tp1Hit !== undefined) db.tp1_hit = trade.tp1Hit
  if (trade.pnl !== undefined) db.pnl = trade.pnl
  if (trade.pnlPct !== undefined) db.pnl_pct = trade.pnlPct
  if (trade.fee !== undefined) db.fee = trade.fee
  if (trade.duration !== undefined) db.duration = trade.duration
  if (trade.binanceOrderId !== undefined) db.binance_order_id = trade.binanceOrderId
  if (trade.stopOrderId !== undefined) db.stop_order_id = trade.stopOrderId
  if (trade.tp1OrderId !== undefined) db.tp1_order_id = trade.tp1OrderId
  if (trade.tp2OrderId !== undefined) db.tp2_order_id = trade.tp2OrderId
  if (trade.openedAt !== undefined) db.opened_at = trade.openedAt
  if (trade.closedAt !== undefined) db.closed_at = trade.closedAt
  if (trade.notes !== undefined) db.notes = trade.notes
  if (trade.clientOrderId !== undefined) db.client_order_id = trade.clientOrderId
  if (trade.actualEntryPrice !== undefined) db.actual_entry_price = trade.actualEntryPrice
  if (trade.actualExitPrice !== undefined) db.actual_exit_price = trade.actualExitPrice
  if (trade.realizedPnlBinance !== undefined) db.realized_pnl_binance = trade.realizedPnlBinance
  return db
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
  await supabaseAdmin.from('bot_logs').insert({
    user_id: userId,
    level,
    message,
    data: data ?? null,
    timestamp: ts,
  })
}

async function logSystem(
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await logUser(SYSTEM_USER_ID, level, message, data)
}

