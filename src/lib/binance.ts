import CryptoJS from 'crypto-js'
import type { Candle, AccountInfo, Position, Ticker, TradingSymbol } from '@/types/trading'

// ─── Credentials & Client Interface ──────────────────────────────────────────

export interface BinanceCredentials {
  apiKey: string
  apiSecret: string
  baseUrl?: string
}

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

export interface PlaceOrderParams {
  symbol: TradingSymbol
  side: 'BUY' | 'SELL'
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET'
  quantity?: number
  price?: number
  stopPrice?: number
  callbackRate?: number
  reduceOnly?: boolean
  positionSide?: 'LONG' | 'SHORT' | 'BOTH'
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX'
  closePosition?: boolean
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
  clientOrderId?: string
}

export interface OrderResponse {
  orderId: number
  symbol: string
  status: string
  side: string
  type: string
  origQty: string
  price: string
  stopPrice?: string
  clientOrderId: string
}

export interface PlaceStopMarketParams {
  symbol: TradingSymbol
  side: 'BUY' | 'SELL'
  stopPrice: number
  quantity: number
  reduceOnly: true
  clientOrderId: string
}

export interface PlaceTakeProfitMarketParams {
  symbol: TradingSymbol
  side: 'BUY' | 'SELL'
  stopPrice: number
  quantity: number
  reduceOnly: true
  clientOrderId: string
}

export interface BinanceClient {
  getKlines(symbol: TradingSymbol, interval: string, limit?: number): Promise<Candle[]>
  getAllPrices(): Promise<Record<string, number>>
  get24hTickers(symbols: TradingSymbol[]): Promise<Ticker[]>
  getExchangeInfo(symbol: TradingSymbol): Promise<{
    pricePrecision: number
    quantityPrecision: number
    minQty: number
    minNotional: number
  }>
  getAccountInfo(): Promise<AccountInfo>
  getOpenOrders(symbol?: TradingSymbol): Promise<unknown[]>
  getOrderStatus(symbol: TradingSymbol, orderId: number): Promise<string>
  getUserTrades(
    symbol: TradingSymbol,
    options?: { startTime?: number; endTime?: number; orderId?: number; limit?: number }
  ): Promise<BinanceUserTrade[]>
  setLeverage(symbol: TradingSymbol, leverage: number): Promise<void>
  setMarginType(symbol: TradingSymbol, marginType: 'ISOLATED'): Promise<void>
  placeOrder(params: PlaceOrderParams): Promise<OrderResponse>
  placeStopMarket(params: PlaceStopMarketParams): Promise<OrderResponse>
  placeTakeProfitMarket(params: PlaceTakeProfitMarketParams): Promise<OrderResponse>
  replaceStopLoss(
    symbol: TradingSymbol,
    oldOrderId: string | null,
    newParams: PlaceStopMarketParams
  ): Promise<OrderResponse>
  cancelOrder(symbol: TradingSymbol, orderId: number): Promise<void>
  cancelAllOrders(symbol: TradingSymbol): Promise<void>
  closePosition(symbol: TradingSymbol, positionAmt: number, side: 'BUY' | 'SELL'): Promise<OrderResponse>
}

// ─── Client-order ID helpers ──────────────────────────────────────────────────

export function generateIntentId(): string {
  return crypto.randomUUID()
}

// Builds a deterministic Binance clientOrderId (max 36 chars) from intent components.
// Same inputs → same ID, so retrying the same trade intent is idempotent in Binance.
export function buildClientOrderId(
  prefix: string,
  userId: string,
  _symbol: string,
  intentId: string
): string {
  const userHash = userId.replace(/-/g, '').slice(0, 8)
  const intentHash = intentId.replace(/-/g, '').slice(0, 12)
  return `t-${prefix}-${userHash}-${intentHash}`.slice(0, 36)
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createBinanceClient(credentials: BinanceCredentials): BinanceClient {
  const baseUrl = credentials.baseUrl ?? 'https://testnet.binancefuture.com'
  const { apiKey, apiSecret } = credentials

  // ── Internal helpers ───────────────────────────────────────────────────────

  function sign(params: Record<string, string | number>): string {
    const query = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString()
    return CryptoJS.HmacSHA256(query, apiSecret).toString()
  }

  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    path: string,
    params: Record<string, string | number> = {},
    signed = false
  ): Promise<T> {
    const timestamp = Date.now()
    const allParams = signed ? { ...params, timestamp, recvWindow: 5000 } : { ...params }
    if (signed) {
      (allParams as Record<string, string | number>).signature = sign(allParams as Record<string, string | number>)
    }

    const query = new URLSearchParams(
      Object.entries(allParams).map(([k, v]) => [k, String(v)])
    ).toString()

    const url = method === 'GET' || method === 'DELETE'
      ? `${baseUrl}${path}?${query}`
      : `${baseUrl}${path}`

    const body = method === 'POST' || method === 'PUT' ? query : undefined

    const res = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
      cache: 'no-store',
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ msg: res.statusText }))
      throw new Error(`Binance API ${method} ${path}: ${err.msg || res.statusText} (${res.status})`)
    }

    return res.json() as Promise<T>
  }

  async function withRetry<T>(
    fn: () => Promise<T>,
    options: { maxAttempts?: number; baseDelayMs?: number } = {}
  ): Promise<T> {
    const maxAttempts = options.maxAttempts ?? 3
    const baseDelayMs = options.baseDelayMs ?? 500
    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastError = err
        // Validation / auth errors are not transient — don't retry
        if (err instanceof Error) {
          const msg = err.message
          if (msg.includes('-1100') || msg.includes('-2010') || msg.includes('-2014')) throw err
        }
        if (attempt === maxAttempts) break
        await new Promise<void>((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)))
      }
    }
    throw lastError
  }

  // ── Public endpoints ───────────────────────────────────────────────────────

  async function getKlines(symbol: TradingSymbol, interval: string, limit = 200): Promise<Candle[]> {
    type RawKline = [number, string, string, string, string, string, number, ...unknown[]]
    const raw = await request<RawKline[]>('GET', '/fapi/v1/klines', { symbol, interval, limit })
    return raw.map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }))
  }

  async function getAllPrices(): Promise<Record<string, number>> {
    type PriceTick = { symbol: string; price: string }
    const data = await request<PriceTick[]>('GET', '/fapi/v1/ticker/price')
    return Object.fromEntries(data.map((d) => [d.symbol, parseFloat(d.price)]))
  }

  async function get24hTickers(symbols: TradingSymbol[]): Promise<Ticker[]> {
    type Raw24h = {
      symbol: string; lastPrice: string; priceChangePercent: string
      priceChange: string; highPrice: string; lowPrice: string; volume: string
    }
    const results: Ticker[] = []
    for (const symbol of symbols) {
      try {
        const d = await request<Raw24h>('GET', '/fapi/v1/ticker/24hr', { symbol })
        results.push({
          symbol: d.symbol as TradingSymbol,
          price: parseFloat(d.lastPrice),
          change24h: parseFloat(d.priceChange),
          changePct24h: parseFloat(d.priceChangePercent),
          high24h: parseFloat(d.highPrice),
          low24h: parseFloat(d.lowPrice),
          volume24h: parseFloat(d.volume),
          lastUpdate: Date.now(),
        })
      } catch {
        // skip failed symbol
      }
    }
    return results
  }

  async function getExchangeInfo(symbol: TradingSymbol): Promise<{
    pricePrecision: number
    quantityPrecision: number
    minQty: number
    minNotional: number
  }> {
    type SymbolInfo = {
      symbol: string
      pricePrecision: number
      quantityPrecision: number
      filters: Array<{ filterType: string; minQty?: string; notional?: string }>
    }
    type ExchangeInfoResponse = { symbols: SymbolInfo[] }
    const data = await request<ExchangeInfoResponse>('GET', '/fapi/v1/exchangeInfo')
    const info = data.symbols.find((s) => s.symbol === symbol)
    if (!info) throw new Error(`Symbol ${symbol} not found`)
    const lotFilter = info.filters.find((f) => f.filterType === 'LOT_SIZE')
    const notionalFilter = info.filters.find((f) => f.filterType === 'MIN_NOTIONAL')
    return {
      pricePrecision: info.pricePrecision,
      quantityPrecision: info.quantityPrecision,
      minQty: lotFilter?.minQty ? parseFloat(lotFilter.minQty) : 0.001,
      minNotional: notionalFilter?.notional ? parseFloat(notionalFilter.notional) : 5,
    }
  }

  // ── Account endpoints ──────────────────────────────────────────────────────

  async function getAccountInfo(): Promise<AccountInfo> {
    type RawAccount = {
      totalWalletBalance: string
      availableBalance: string
      totalUnrealizedProfit: string
      totalMarginBalance: string
      positions: Array<{
        symbol: string
        positionAmt: string
        entryPrice: string
        markPrice: string
        unrealizedProfit: string
        leverage: string
        marginType: string
        liquidationPrice: string
        positionSide: string
      }>
    }
    const data = await withRetry(() => request<RawAccount>('GET', '/fapi/v2/account', {}, true))
    return {
      totalBalance: parseFloat(data.totalWalletBalance),
      availableBalance: parseFloat(data.availableBalance),
      totalUnrealizedPnl: parseFloat(data.totalUnrealizedProfit),
      totalMarginBalance: parseFloat(data.totalMarginBalance),
      positions: data.positions
        .filter((p) => parseFloat(p.positionAmt) !== 0)
        .map((p) => ({
          symbol: p.symbol as TradingSymbol,
          positionAmt: parseFloat(p.positionAmt),
          entryPrice: parseFloat(p.entryPrice),
          markPrice: parseFloat(p.markPrice),
          unrealizedPnl: parseFloat(p.unrealizedProfit),
          leverage: parseInt(p.leverage),
          marginType: p.marginType as Position['marginType'],
          liquidationPrice: parseFloat(p.liquidationPrice),
          positionSide: p.positionSide as Position['positionSide'],
        })),
    }
  }

  async function getOpenOrders(symbol?: TradingSymbol): Promise<unknown[]> {
    const params: Record<string, string | number> = {}
    if (symbol) params.symbol = symbol
    return request<unknown[]>('GET', '/fapi/v1/openOrders', params, true)
  }

  async function getOrderStatus(symbol: TradingSymbol, orderId: number): Promise<string> {
    type OrderStatusResponse = { status: string }
    const data = await request<OrderStatusResponse>('GET', '/fapi/v1/order', { symbol, orderId }, true)
    return data.status
  }

  async function getUserTrades(
    symbol: TradingSymbol,
    options: { startTime?: number; endTime?: number; orderId?: number; limit?: number } = {}
  ): Promise<BinanceUserTrade[]> {
    const params: Record<string, string | number> = { symbol }
    if (options.startTime !== undefined) params.startTime = options.startTime
    if (options.endTime !== undefined) params.endTime = options.endTime
    if (options.orderId !== undefined) params.orderId = options.orderId
    params.limit = options.limit ?? 100

    type RawUserTrade = {
      symbol: string; id: number; orderId: number; side: string
      price: string; qty: string; realizedPnl: string
      commission: string; commissionAsset: string; time: number
    }
    const raw = await request<RawUserTrade[]>('GET', '/fapi/v1/userTrades', params, true)
    return raw.map((t) => ({
      symbol: t.symbol,
      id: t.id,
      orderId: t.orderId,
      side: t.side as 'BUY' | 'SELL',
      price: parseFloat(t.price),
      qty: parseFloat(t.qty),
      realizedPnl: parseFloat(t.realizedPnl),
      commission: parseFloat(t.commission),
      commissionAsset: t.commissionAsset,
      time: t.time,
    }))
  }

  // ── Trading endpoints ──────────────────────────────────────────────────────

  async function setLeverage(symbol: TradingSymbol, leverage: number): Promise<void> {
    await withRetry(() => request('POST', '/fapi/v1/leverage', { symbol, leverage }, true))
  }

  // Only accepts ISOLATED. Throws a descriptive error if Binance rejects it for any
  // reason other than "already ISOLATED" (-4046 / "No need to change").
  async function setMarginType(symbol: TradingSymbol, marginType: 'ISOLATED'): Promise<void> {
    try {
      await withRetry(() => request('POST', '/fapi/v1/marginType', { symbol, marginType }, true))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('No need to change')) return
      if (msg.includes('-4046')) return
      throw new Error(
        `No se pudo configurar margin type ISOLATED en ${symbol}: ${msg}. ` +
        `Verifica que la cuenta no tenga posiciones abiertas en ${symbol} con CROSS y que el modo dual no esté activo.`
      )
    }
  }

  async function placeOrder(params: PlaceOrderParams): Promise<OrderResponse> {
    const body: Record<string, string | number> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
    }
    if (params.quantity !== undefined) body.quantity = params.quantity
    if (params.price !== undefined) body.price = params.price
    if (params.stopPrice !== undefined) body.stopPrice = params.stopPrice
    if (params.callbackRate !== undefined) body.callbackRate = params.callbackRate
    if (params.reduceOnly !== undefined) body.reduceOnly = params.reduceOnly.toString()
    if (params.positionSide !== undefined) body.positionSide = params.positionSide
    if (params.timeInForce !== undefined) body.timeInForce = params.timeInForce
    if (params.closePosition !== undefined) body.closePosition = params.closePosition.toString()
    if (params.workingType !== undefined) body.workingType = params.workingType
    // clientOrderId → newClientOrderId in Binance API body
    if (params.clientOrderId !== undefined) body.newClientOrderId = params.clientOrderId

    return withRetry(() => request<OrderResponse>('POST', '/fapi/v1/order', body, true))
  }

  // Places a STOP_MARKET order using MARK_PRICE to avoid false triggers on wicks.
  // Idempotent: same clientOrderId → Binance deduplicates.
  async function placeStopMarket(params: PlaceStopMarketParams): Promise<OrderResponse> {
    return withRetry(() =>
      placeOrder({
        symbol: params.symbol,
        side: params.side,
        type: 'STOP_MARKET',
        stopPrice: params.stopPrice,
        quantity: params.quantity,
        reduceOnly: true,
        timeInForce: 'GTC',
        workingType: 'MARK_PRICE',
        clientOrderId: params.clientOrderId,
      })
    )
  }

  // Places a TAKE_PROFIT_MARKET order using MARK_PRICE.
  async function placeTakeProfitMarket(params: PlaceTakeProfitMarketParams): Promise<OrderResponse> {
    return withRetry(() =>
      placeOrder({
        symbol: params.symbol,
        side: params.side,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: params.stopPrice,
        quantity: params.quantity,
        reduceOnly: true,
        timeInForce: 'GTC',
        workingType: 'MARK_PRICE',
        clientOrderId: params.clientOrderId,
      })
    )
  }

  // Cancels an existing SL order (if any) then places the new one.
  // Ignores -2011 (order already cancelled/filled) to make it safe to call even
  // if the old order no longer exists.
  async function replaceStopLoss(
    symbol: TradingSymbol,
    oldOrderId: string | null,
    newParams: PlaceStopMarketParams
  ): Promise<OrderResponse> {
    if (oldOrderId) {
      try {
        await cancelOrder(symbol, parseInt(oldOrderId))
      } catch (e) {
        if (
          !(
            e instanceof Error &&
            (e.message.includes('-2011') || e.message.includes('Unknown order'))
          )
        ) {
          throw e
        }
      }
    }
    return placeStopMarket(newParams)
  }

  async function cancelOrder(symbol: TradingSymbol, orderId: number): Promise<void> {
    await withRetry(() => request('DELETE', '/fapi/v1/order', { symbol, orderId }, true))
  }

  async function cancelAllOrders(symbol: TradingSymbol): Promise<void> {
    await request('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true)
  }

  async function closePosition(
    symbol: TradingSymbol,
    positionAmt: number,
    side: 'BUY' | 'SELL'
  ): Promise<OrderResponse> {
    return placeOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity: Math.abs(positionAmt),
      reduceOnly: true,
    })
  }

  return {
    getKlines,
    getAllPrices,
    get24hTickers,
    getExchangeInfo,
    getAccountInfo,
    getOpenOrders,
    getOrderStatus,
    getUserTrades,
    setLeverage,
    setMarginType,
    placeOrder,
    placeStopMarket,
    placeTakeProfitMarket,
    replaceStopLoss,
    cancelOrder,
    cancelAllOrders,
    closePosition,
  }
}

// ─── Default client (single-user, reads from env vars) ───────────────────────

export const defaultClient = createBinanceClient({
  apiKey: process.env.BINANCE_API_KEY!,
  apiSecret: process.env.BINANCE_API_SECRET!,
  baseUrl: process.env.BINANCE_BASE_URL || 'https://testnet.binancefuture.com',
})

// ─── Backwards-compatible module-level exports (delegate to defaultClient) ───
// Existing callers (trading-engine.ts, etc.) continue to work without changes.

export const getKlines = (symbol: TradingSymbol, interval: string, limit?: number) =>
  defaultClient.getKlines(symbol, interval, limit)

export const getAllPrices = () => defaultClient.getAllPrices()

export const get24hTickers = (symbols: TradingSymbol[]) =>
  defaultClient.get24hTickers(symbols)

export const getExchangeInfo = (symbol: TradingSymbol) =>
  defaultClient.getExchangeInfo(symbol)

export const getAccountInfo = () => defaultClient.getAccountInfo()

export const getOpenOrders = (symbol?: TradingSymbol) =>
  defaultClient.getOpenOrders(symbol)

export const setLeverage = (symbol: TradingSymbol, leverage: number) =>
  defaultClient.setLeverage(symbol, leverage)

export const setMarginType = (symbol: TradingSymbol, marginType: 'ISOLATED') =>
  defaultClient.setMarginType(symbol, marginType)

export const placeOrder = (params: PlaceOrderParams) =>
  defaultClient.placeOrder(params)

export const cancelOrder = (symbol: TradingSymbol, orderId: number) =>
  defaultClient.cancelOrder(symbol, orderId)

export const cancelAllOrders = (symbol: TradingSymbol) =>
  defaultClient.cancelAllOrders(symbol)

export const closePosition = (symbol: TradingSymbol, positionAmt: number, side: 'BUY' | 'SELL') =>
  defaultClient.closePosition(symbol, positionAmt, side)

// ─── Pure math helpers ────────────────────────────────────────────────────────

export function roundQty(qty: number, precision: number): number {
  const factor = Math.pow(10, precision)
  return Math.floor(qty * factor) / factor
}

export function roundPrice(price: number, precision: number): number {
  const factor = Math.pow(10, precision)
  return Math.round(price * factor) / factor
}
