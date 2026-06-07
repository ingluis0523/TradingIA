import { getKlines, getAccountInfo, placeOrder, cancelOrder, setLeverage, setMarginType, roundPrice, roundQty } from './binance'
import { generateSignal, shouldCloseEarly } from './strategy/signals'
import { calculatePositionSize, checkCanOpenPosition, calculateDailyLoss, calculateTrailingStop, validateRiskReward } from './strategy/risk'
import { calculateIndicators } from './strategy/indicators'
import { getBotConfig, getOpenTrades, createTrade, updateTrade, saveSignal, addLog, updateBotConfig } from './supabase'
import type { BotConfig, Signal, Trade, TradingSymbol } from '@/types/trading'
import { TRADING_SYMBOLS, SYMBOL_INFO } from '@/types/trading'

export interface EngineResult {
  success: boolean
  message: string
  tradesOpened: number
  tradesClosed: number
  signalsGenerated: number
  errors: string[]
}

type AccountInfo = Awaited<ReturnType<typeof getAccountInfo>>
type Position = AccountInfo['positions'][number]
type Candles = Awaited<ReturnType<typeof getKlines>>

// ─── Main Engine Tick ─────────────────────────────────────────────────────────

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
    const config = await getBotConfig()
    if (!config) {
      result.message = 'Bot no configurado en Supabase'
      await log('WARN', '⚠️ Tick recibido pero el bot no está configurado aún')
      return result
    }
    if (!config.isRunning) {
      result.message = 'Bot detenido'
      result.success = true
      await log('INFO', '⏸️ Tick recibido — bot en pausa')
      return result
    }

    await log('INFO', `⚙️ Tick iniciado — ${config.symbols.length} pares | Capital: $${config.currentCapital?.toFixed(2)}`)

    const [account, openTrades] = await Promise.all([
      getAccountInfo(),
      getOpenTrades(),
    ])

    // ── Reconcile orphaned Binance positions (open on exchange, missing in DB) ──
    await reconcileOrphanedPositions(account.positions, openTrades, config, result)

    const dailyLoss = calculateDailyLoss(openTrades)
    const dailyLossPct = config.currentCapital > 0 ? Math.abs(dailyLoss) / config.currentCapital : 0

    if (dailyLossPct >= config.maxDailyLoss) {
      await log('WARN', `⚠️ Límite de pérdida diaria alcanzado: ${(dailyLossPct * 100).toFixed(2)}%. Trading pausado.`)
      result.message = 'Límite de pérdida diaria alcanzado'
      result.success = true
      return result
    }

    for (const symbol of config.symbols) {
      try {
        await processSymbol(symbol, config, account, openTrades, dailyLoss, result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`${symbol}: ${msg}`)
        await log('ERROR', `❌ Error procesando ${symbol}: ${msg}`)
      }
    }

    const newCapital = account.totalMarginBalance + account.totalUnrealizedPnl
    await updateBotConfig({ currentCapital: newCapital > 0 ? newCapital : config.currentCapital })

    result.success = true
    result.message = `Tick completado. Abiertos: ${result.tradesOpened}, Cerrados: ${result.tradesClosed}, Señales: ${result.signalsGenerated}`
    await log('INFO', `✅ ${result.message}`)

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.message = msg
    result.errors.push(msg)
    await log('ERROR', `❌ Error crítico en motor: ${msg}`)
  }

  return result
}

// ─── Reconcile Orphaned Positions ─────────────────────────────────────────────
// Binance has a position but we have no DB record — create a minimal record so
// the engine can manage it next tick.

async function reconcileOrphanedPositions(
  binancePositions: Position[],
  openTrades: Trade[],
  config: BotConfig,
  result: EngineResult,
): Promise<void> {
  for (const bPos of binancePositions) {
    const symbol = bPos.symbol as TradingSymbol
    if (!TRADING_SYMBOLS.includes(symbol)) continue
    const alreadyTracked = openTrades.some((t) => t.symbol === symbol && t.status === 'OPEN')
    if (alreadyTracked) continue

    const posQty = Math.abs(bPos.positionAmt)
    const side = bPos.positionAmt > 0 ? 'BUY' : 'SELL'
    const entryPrice = bPos.entryPrice
    const symbolInfo = SYMBOL_INFO[symbol]

    await log('WARN', `⚠️ Posición huérfana detectada en ${symbol}: ${side} ${posQty} @ ${entryPrice}. Creando registro y SL de emergencia.`)

    const direction = side === 'BUY' ? 1 : -1
    const emergencySl = roundPrice(entryPrice * (1 - direction * 0.02), symbolInfo.pricePrecision)
    const slOrderId: string | undefined = undefined

    try {
      await createTrade({
        symbol,
        side,
        status: 'OPEN',
        entryPrice,
        quantity: posQty,
        leverage: config.leverage,
        stopLoss: emergencySl,
        takeProfit1: roundPrice(entryPrice * (1 + direction * 0.03), symbolInfo.pricePrecision),
        takeProfit2: roundPrice(entryPrice * (1 + direction * 0.05), symbolInfo.pricePrecision),
        tp1Hit: false,
        fee: entryPrice * posQty * 0.0004,
        binanceOrderId: '',
        stopOrderId: slOrderId,
        tp1OrderId: undefined,
        tp2OrderId: undefined,
        openedAt: new Date().toISOString(),
        notes: 'Reconciliado automáticamente — registro faltaba en BD',
      })
      result.tradesOpened++
    } catch (e) {
      await log('ERROR', `❌ No se pudo crear registro para posición huérfana ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// ─── Process Single Symbol ─────────────────────────────────────────────────────

async function processSymbol(
  symbol: TradingSymbol,
  config: BotConfig,
  account: AccountInfo,
  openTrades: Trade[],
  dailyLoss: number,
  result: EngineResult,
): Promise<void> {
  const [candles1h, candles4h] = await Promise.all([
    getKlines(symbol, '1h', 250),
    getKlines(symbol, '4h', 250),
  ])

  const currentPrice = candles1h[candles1h.length - 1].close

  const existingTrade = openTrades.find((t) => t.symbol === symbol && t.status === 'OPEN')
  if (existingTrade) {
    const closed = await managePosition(existingTrade, currentPrice, candles1h, config, account.positions)
    if (closed) result.tradesClosed++
    return
  }

  const signal = await generateSignal({ symbol, candles1h, candles4h, currentPrice })
  if (!signal) return

  result.signalsGenerated++
  await saveSignal(signal)
  await log('INFO', `📊 Señal ${signal.type} en ${symbol} | Strength: ${signal.strength}% | Precio: ${currentPrice}`)

  const riskCheck = checkCanOpenPosition(signal, openTrades, account, config, dailyLoss)
  if (!riskCheck.allowed) {
    await log('WARN', `⛔ Señal rechazada en ${symbol}: ${riskCheck.reason}`)
    return
  }

  const side = signal.type === 'LONG' ? 'BUY' : 'SELL'
  if (!validateRiskReward(currentPrice, signal.stopLoss, signal.takeProfit1, side, 1.5)) {
    await log('WARN', `⛔ R:R insuficiente en ${symbol}, señal descartada`)
    return
  }

  await openPosition(symbol, signal, config, result)
}

// ─── Open Position ─────────────────────────────────────────────────────────────

async function openPosition(
  symbol: TradingSymbol,
  signal: Signal,
  config: BotConfig,
  result: EngineResult,
): Promise<void> {
  const symbolInfo = SYMBOL_INFO[symbol]
  const side = signal.type === 'LONG' ? 'BUY' : 'SELL'
  const slSide = side === 'BUY' ? 'SELL' : 'BUY'
  const leverage = config.leverage

  try { await setLeverage(symbol, leverage) } catch (e) {
    await log('WARN', `⚠️ setLeverage falló en ${symbol} (continuando): ${e instanceof Error ? e.message : String(e)}`)
  }
  try { await setMarginType(symbol, 'ISOLATED') } catch (e) {
    await log('WARN', `⚠️ setMarginType falló en ${symbol} (continuando): ${e instanceof Error ? e.message : String(e)}`)
  }

  const ps = calculatePositionSize(
    config.currentCapital,
    config.riskPerTrade,
    signal.price,
    signal.stopLoss,
    leverage,
    symbolInfo.qtyPrecision,
  )

  if (ps.quantity < symbolInfo.minQty) {
    await log('WARN', `⛔ Cantidad muy pequeña en ${symbol}: ${ps.quantity} < ${symbolInfo.minQty}`)
    return
  }

  const slPrice = roundPrice(signal.stopLoss, symbolInfo.pricePrecision)
  const tp1Price = roundPrice(signal.takeProfit1, symbolInfo.pricePrecision)
  const tp2Price = roundPrice(signal.takeProfit2, symbolInfo.pricePrecision)

  // 1. Place entry order
  const entryOrder = await placeOrder({
    symbol,
    side,
    type: 'MARKET',
    quantity: ps.quantity,
  })

  const entryPrice = signal.price

  // 2. Save trade to DB immediately — before placing SL/TP
  const trade = await createTrade({
    symbol,
    side,
    status: 'OPEN',
    entryPrice,
    quantity: ps.quantity,
    leverage,
    stopLoss: slPrice,
    takeProfit1: tp1Price,
    takeProfit2: tp2Price,
    tp1Hit: false,
    fee: ps.positionValue * 0.0004,
    binanceOrderId: String(entryOrder.orderId),
    stopOrderId: undefined,
    tp1OrderId: undefined,
    tp2OrderId: undefined,
    openedAt: new Date().toISOString(),
  })

  result.tradesOpened++

  // 3. SL — managed by software in managePosition (STOP_MARKET not supported on Testnet)

  // 4. TP1 — partial close (50%), uses reduceOnly + explicit quantity
  const tp1Qty = roundQty(ps.quantity * 0.5, symbolInfo.qtyPrecision)
  try {
    const tp1Order = await placeOrder({
      symbol,
      side: slSide,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tp1Price,
      quantity: tp1Qty,
      reduceOnly: true,
    })
    await updateTrade(trade.id, { tp1OrderId: String(tp1Order.orderId) })
  } catch (e) {
    await log('WARN', `⚠️ TP1 no colocado en ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 5. TP2 — remaining 50%, explicit qty (Binance allows only one closePosition order per symbol)
  const tp2Qty = roundQty(ps.quantity * 0.5, symbolInfo.qtyPrecision)
  try {
    const tp2Order = await placeOrder({
      symbol,
      side: slSide,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tp2Price,
      quantity: tp2Qty,
      reduceOnly: true,
    })
    await updateTrade(trade.id, { tp2OrderId: String(tp2Order.orderId) })
  } catch (e) {
    await log('WARN', `⚠️ TP2 no colocado en ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }

  await log('TRADE', `✅ ENTRADA ${side} ${symbol} | Qty: ${ps.quantity} | Precio: ${entryPrice} | SL: ${slPrice} | TP1: ${tp1Price} | TP2: ${tp2Price} | Riesgo: $${ps.riskAmount.toFixed(2)}`, {
    tradeId: trade.id, symbol, side, quantity: ps.quantity, entryPrice, stopLoss: slPrice,
  })
}

// ─── Manage Existing Position ─────────────────────────────────────────────────
// Returns true if the position was closed this tick.

async function managePosition(
  trade: Trade,
  currentPrice: number,
  candles1h: Candles,
  config: BotConfig,
  binancePositions: Position[],
): Promise<boolean> {
  const symbolInfo = SYMBOL_INFO[trade.symbol]
  const direction = trade.side === 'BUY' ? 1 : -1

  // ── Check if position was closed on Binance (TP/SL filled) ────────────────
  const stillOpenOnBinance = binancePositions.some(
    (p) => p.symbol === trade.symbol && Math.abs(p.positionAmt) > 0,
  )

  // ── Software stop loss check ──────────────────────────────────────────────
  if (stillOpenOnBinance) {
    const slBreached = trade.side === 'BUY'
      ? currentPrice <= trade.stopLoss
      : currentPrice >= trade.stopLoss
    if (slBreached) {
      await closePositionEarly(trade, currentPrice, `Stop Loss activado (SL: ${trade.stopLoss})`)
      return true
    }
  }

  if (!stillOpenOnBinance) {
    // Position was closed by TP or SL on exchange — mark DB record accordingly
    const pnl = (currentPrice - trade.entryPrice) * direction * trade.quantity - trade.fee
    const pnlPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * direction * trade.leverage * 100
    const duration = Date.now() - new Date(trade.openedAt).getTime()

    await updateTrade(trade.id, {
      status: 'CLOSED',
      exitPrice: currentPrice,
      pnl,
      pnlPct,
      duration,
      closedAt: new Date().toISOString(),
      notes: 'Cerrado por TP/SL en Binance',
    })

    await log('TRADE', `🏁 Posición cerrada en Binance: ${trade.symbol} | P&L: $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`, {
      tradeId: trade.id, pnl, pnlPct,
    })
    return true
  }

  const unrealizedPnlPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * direction * trade.leverage * 100

  // ── Check TP1 hit ──────────────────────────────────────────────────────────
  const tp1Reached = trade.side === 'BUY'
    ? currentPrice >= trade.takeProfit1
    : currentPrice <= trade.takeProfit1

  if (tp1Reached && !trade.tp1Hit) {
    await updateTrade(trade.id, { tp1Hit: true })
    await log('TRADE', `🎯 TP1 alcanzado en ${trade.symbol} | Precio: ${currentPrice} | P&L: ${unrealizedPnlPct.toFixed(2)}%`)

    // Move SL to break-even on Binance
    const beSl = roundPrice(trade.entryPrice * (1 + direction * 0.001), symbolInfo.pricePrecision)
    const slSide = trade.side === 'BUY' ? 'SELL' : 'BUY'

    await updateTrade(trade.id, { stopLoss: beSl })
    await log('INFO', `🔒 SL movido a break-even en ${trade.symbol}: ${beSl}`)
  }

  // ── Trailing stop after TP1 ────────────────────────────────────────────────
  if (trade.tp1Hit && candles1h.length >= 210) {
    const ind = calculateIndicators(candles1h)
    const newSl = calculateTrailingStop(trade, currentPrice, ind.atr14)

    if (newSl !== null) {
      const roundedSl = roundPrice(newSl, symbolInfo.pricePrecision)
      const slSide = trade.side === 'BUY' ? 'SELL' : 'BUY'

      await updateTrade(trade.id, { stopLoss: roundedSl })
      await log('INFO', `🔄 Trailing stop actualizado en ${trade.symbol}: ${roundedSl}`)
    }
  }

  // ── Early exit check ───────────────────────────────────────────────────────
  if (candles1h.length >= 210) {
    const closeEarly = shouldCloseEarly(trade.side, candles1h, currentPrice, trade.entryPrice)
    if (closeEarly) {
      await closePositionEarly(trade, currentPrice, 'Señal de cierre anticipado (reversión de tendencia)')
      return true
    }
  }

  return false
}

// ─── Close Position Early ─────────────────────────────────────────────────────

async function closePositionEarly(trade: Trade, currentPrice: number, reason: string): Promise<void> {
  const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const direction = trade.side === 'BUY' ? 1 : -1

  // Cancel existing SL/TP orders before placing market close
  if (trade.stopOrderId) {
    try { await cancelOrder(trade.symbol, parseInt(trade.stopOrderId)) } catch {}
  }
  if (trade.tp1OrderId) {
    try { await cancelOrder(trade.symbol, parseInt(trade.tp1OrderId)) } catch {}
  }
  if (trade.tp2OrderId) {
    try { await cancelOrder(trade.symbol, parseInt(trade.tp2OrderId)) } catch {}
  }

  await placeOrder({
    symbol: trade.symbol,
    side: closeSide,
    type: 'MARKET',
    quantity: trade.quantity,
    reduceOnly: true,
  })

  const pnl = (currentPrice - trade.entryPrice) * direction * trade.quantity - trade.fee
  const pnlPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * direction * trade.leverage * 100
  const duration = Date.now() - new Date(trade.openedAt).getTime()

  await updateTrade(trade.id, {
    status: 'CLOSED',
    exitPrice: currentPrice,
    pnl,
    pnlPct,
    duration,
    closedAt: new Date().toISOString(),
    notes: reason,
  })

  await log('TRADE', `🔴 CIERRE anticipado ${trade.symbol} | P&L: $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) | Razón: ${reason}`, {
    tradeId: trade.id, pnl, pnlPct,
  })
}

// ─── Logger ───────────────────────────────────────────────────────────────────

async function log(
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'TRADE',
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  console.log(`[${level}] ${message}`)
  await addLog({ level, message, data, timestamp: new Date().toISOString() })
}
