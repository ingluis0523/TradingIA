import { getKlines, getAccountInfo, placeOrder, cancelOrder, setLeverage, setMarginType, roundPrice, roundQty } from './binance'
import { generateSignal, shouldCloseEarly } from './strategy/signals'
import { calculatePositionSize, checkCanOpenPosition, calculateDailyLoss, calculateTrailingStop, validateRiskReward, getSymbolQtyPrecision } from './strategy/risk'
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

// ─── Main Engine Tick ─────────────────────────────────────────────────────────
// Called every minute via Vercel Cron Job

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
    // ── Load configuration ──────────────────────────────────────────────────
    const config = await getBotConfig()
    if (!config) {
      result.message = 'Bot no configurado en Supabase'
      await log('WARN', '⚠️ Tick recibido pero el bot no está configurado aún')
      return result
    }
    if (!config.isRunning) {
      result.message = 'Bot detenido'
      result.success = true
      await log('INFO', '⏸️ Tick recibido — bot en pausa (presiona Iniciar Bot para activar)')
      return result
    }

    await log('INFO', `⚙️ Tick iniciado — analizando ${config.symbols.length} pares | Capital: $${config.currentCapital?.toFixed(2)}`)

    // ── Load account and open trades ────────────────────────────────────────
    const [account, openTrades] = await Promise.all([
      getAccountInfo(),
      getOpenTrades(),
    ])

    const dailyLoss = calculateDailyLoss(openTrades)
    const dailyLossPct = Math.abs(dailyLoss) / config.currentCapital

    if (dailyLossPct >= config.maxDailyLoss) {
      await log('WARN', `⚠️ Límite de pérdida diaria alcanzado: ${(dailyLossPct * 100).toFixed(2)}%. Trading pausado por hoy.`)
      result.message = 'Límite de pérdida diaria alcanzado'
      result.success = true
      return result
    }

    // ── Process each symbol ─────────────────────────────────────────────────
    for (const symbol of config.symbols) {
      try {
        await processSymbol(symbol, config, account, openTrades, dailyLoss, result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`${symbol}: ${msg}`)
        await log('ERROR', `❌ Error procesando ${symbol}: ${msg}`)
      }
    }

    // ── Update current capital ──────────────────────────────────────────────
    await updateBotConfig({ currentCapital: account.totalMarginBalance + account.totalUnrealizedPnl })

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

// ─── Process Single Symbol ─────────────────────────────────────────────────────

async function processSymbol(
  symbol: TradingSymbol,
  config: BotConfig,
  account: Awaited<ReturnType<typeof getAccountInfo>>,
  openTrades: Trade[],
  dailyLoss: number,
  result: EngineResult
): Promise<void> {

  // ── Fetch price data ──────────────────────────────────────────────────────
  const [candles1h, candles4h] = await Promise.all([
    getKlines(symbol, '1h', 250),
    getKlines(symbol, '4h', 250),
  ])

  const currentPrice = candles1h[candles1h.length - 1].close

  // ── Manage existing position ───────────────────────────────────────────────
  const existingTrade = openTrades.find((t) => t.symbol === symbol && t.status === 'OPEN')
  if (existingTrade) {
    await managePosition(existingTrade, currentPrice, candles1h, config)
    return
  }

  // ── Generate signal ────────────────────────────────────────────────────────
  const signal = await generateSignal({ symbol, candles1h, candles4h, currentPrice })
  if (!signal) return

  result.signalsGenerated++
  await saveSignal(signal)
  await log('INFO', `📊 Señal ${signal.type} en ${symbol} | Strength: ${signal.strength}% | Precio: ${currentPrice}`)

  // ── Risk check ─────────────────────────────────────────────────────────────
  const riskCheck = checkCanOpenPosition(signal, openTrades, account, config, dailyLoss)
  if (!riskCheck.allowed) {
    await log('WARN', `⛔ Señal rechazada en ${symbol}: ${riskCheck.reason}`)
    return
  }

  // ── Validate R:R ───────────────────────────────────────────────────────────
  const side = signal.type === 'LONG' ? 'BUY' : 'SELL'
  if (!validateRiskReward(currentPrice, signal.stopLoss, signal.takeProfit1, side, 1.5)) {
    await log('WARN', `⛔ R:R insuficiente en ${symbol}, señal descartada`)
    return
  }

  // ── Open position ──────────────────────────────────────────────────────────
  await openPosition(symbol, signal, config, result)
}

// ─── Open Position ─────────────────────────────────────────────────────────────

async function openPosition(
  symbol: TradingSymbol,
  signal: Signal,
  config: BotConfig,
  result: EngineResult
): Promise<void> {
  const symbolInfo = SYMBOL_INFO[symbol]
  const side = signal.type === 'LONG' ? 'BUY' : 'SELL'
  const leverage = config.leverage

  // Set leverage and margin type
  await setLeverage(symbol, leverage)
  await setMarginType(symbol, config.marginType)

  // Calculate position size
  const ps = calculatePositionSize(
    config.currentCapital,
    config.riskPerTrade,
    signal.price,
    signal.stopLoss,
    leverage,
    symbolInfo.qtyPrecision
  )

  if (ps.quantity < symbolInfo.minQty) {
    await log('WARN', `⛔ Cantidad muy pequeña en ${symbol}: ${ps.quantity} < ${symbolInfo.minQty}`)
    return
  }

  // Place market entry order
  const entryOrder = await placeOrder({
    symbol,
    side,
    type: 'MARKET',
    quantity: ps.quantity,
  })

  const entryPrice = signal.price

  // Place stop loss order (opposite side, reduceOnly)
  const slSide = side === 'BUY' ? 'SELL' : 'BUY'
  const slPrice = roundPrice(signal.stopLoss, symbolInfo.pricePrecision)
  const tp1Price = roundPrice(signal.takeProfit1, symbolInfo.pricePrecision)
  const tp2Price = roundPrice(signal.takeProfit2, symbolInfo.pricePrecision)

  const slOrder = await placeOrder({
    symbol,
    side: slSide,
    type: 'STOP_MARKET',
    stopPrice: slPrice,
    closePosition: true,
    reduceOnly: true,
  })

  // Place TP1 (50% of position)
  const tp1Qty = roundQty(ps.quantity * 0.5, symbolInfo.qtyPrecision)
  const tp1Order = await placeOrder({
    symbol,
    side: slSide,
    type: 'TAKE_PROFIT_MARKET',
    stopPrice: tp1Price,
    quantity: tp1Qty,
    reduceOnly: true,
  })

  // Place TP2 (remaining 50%)
  const tp2Qty = roundQty(ps.quantity * 0.5, symbolInfo.qtyPrecision)
  const tp2Order = await placeOrder({
    symbol,
    side: slSide,
    type: 'TAKE_PROFIT_MARKET',
    stopPrice: tp2Price,
    quantity: tp2Qty,
    reduceOnly: true,
  })

  // Record trade in database
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
    fee: ps.positionValue * 0.0004, // 0.04% taker fee
    binanceOrderId: String(entryOrder.orderId),
    stopOrderId: String(slOrder.orderId),
    tp1OrderId: String(tp1Order.orderId),
    tp2OrderId: String(tp2Order.orderId),
    openedAt: new Date().toISOString(),
  })

  result.tradesOpened++
  await log('TRADE', `✅ ENTRADA ${side} ${symbol} | Qty: ${ps.quantity} | Precio: ${entryPrice} | SL: ${slPrice} | TP1: ${tp1Price} | TP2: ${tp2Price} | Riesgo: $${ps.riskAmount.toFixed(2)}`, {
    tradeId: trade.id, symbol, side, quantity: ps.quantity, entryPrice, stopLoss: slPrice,
  })
}

// ─── Manage Existing Position ─────────────────────────────────────────────────

async function managePosition(
  trade: Trade,
  currentPrice: number,
  candles1h: Awaited<ReturnType<typeof getKlines>>,
  config: BotConfig,
): Promise<void> {
  const direction = trade.side === 'BUY' ? 1 : -1
  const unrealizedPnlPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * direction * trade.leverage * 100

  // ── Check TP1 hit ──────────────────────────────────────────────────────────
  const tp1Hit = trade.side === 'BUY'
    ? currentPrice >= trade.takeProfit1
    : currentPrice <= trade.takeProfit1

  if (tp1Hit && !trade.tp1Hit) {
    await updateTrade(trade.id, { tp1Hit: true })
    await log('TRADE', `🎯 TP1 alcanzado en ${trade.symbol} | Precio: ${currentPrice} | P&L estimado: ${unrealizedPnlPct.toFixed(2)}%`)

    // Move SL to break even + small profit
    const newSl = trade.entryPrice + direction * (currentPrice - trade.entryPrice) * 0.1
    await updateTrade(trade.id, { stopLoss: newSl })
  }

  // ── Trailing stop after TP1 ────────────────────────────────────────────────
  if (trade.tp1Hit && candles1h.length >= 210) {
    const ind = calculateIndicators(candles1h)
    const newSl = calculateTrailingStop(trade, currentPrice, ind.atr14)
    if (newSl !== null) {
      const symbolInfo = SYMBOL_INFO[trade.symbol]
      const roundedSl = roundPrice(newSl, symbolInfo.pricePrecision)
      if (trade.stopOrderId) {
        try {
          await cancelOrder(trade.symbol, parseInt(trade.stopOrderId))
        } catch {
          // Order might already be filled
        }
      }
      await placeOrder({
        symbol: trade.symbol,
        side: trade.side === 'BUY' ? 'SELL' : 'BUY',
        type: 'STOP_MARKET',
        stopPrice: roundedSl,
        closePosition: true,
        reduceOnly: true,
      })
      await updateTrade(trade.id, { stopLoss: roundedSl })
      await log('INFO', `🔄 Trailing stop actualizado en ${trade.symbol}: ${roundedSl}`)
    }
  }

  // ── Early exit check ───────────────────────────────────────────────────────
  if (candles1h.length >= 210) {
    const closeEarly = shouldCloseEarly(trade.side, candles1h, currentPrice, trade.entryPrice)
    if (closeEarly) {
      await closePositionEarly(trade, currentPrice, 'Señal de cierre anticipado (reversión de tendencia)')
    }
  }
}

// ─── Close Position Early ─────────────────────────────────────────────────────

async function closePositionEarly(trade: Trade, currentPrice: number, reason: string): Promise<void> {
  const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const direction = trade.side === 'BUY' ? 1 : -1

  await placeOrder({
    symbol: trade.symbol,
    side: closeSide,
    type: 'MARKET',
    quantity: trade.quantity,
    reduceOnly: true,
  })

  const pnl = (currentPrice - trade.entryPrice) * direction * trade.quantity - trade.fee
  const pnlPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * direction * trade.leverage * 100
  const openTime = new Date(trade.openedAt).getTime()
  const duration = Date.now() - openTime

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
  data?: Record<string, unknown>
): Promise<void> {
  console.log(`[${level}] ${message}`)
  await addLog({ level, message, data, timestamp: new Date().toISOString() })
}
