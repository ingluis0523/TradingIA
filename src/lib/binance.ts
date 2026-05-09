import CryptoJS from 'crypto-js'
import type { Candle, AccountInfo, Position, Ticker, TradingSymbol } from '@/types/trading'

const BASE_URL = process.env.BINANCE_BASE_URL || 'https://testnet.binancefuture.com'
const API_KEY = process.env.BINANCE_API_KEY || ''
const API_SECRET = process.env.BINANCE_API_SECRET || ''

// ─── Request Helpers ─────────────────────────────────────────────────────────

function sign(params: Record<string, string | number>): string {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString()
  return CryptoJS.HmacSHA256(query, API_SECRET).toString()
}

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
  path: string,
  params: Record<string, string | number> = {},
  signed = false
): Promise<T> {
  const timestamp = Date.now()
  const allParams = signed ? { ...params, timestamp, recvWindow: 5000 } : params
  if (signed) {
    (allParams as Record<string, string | number>).signature = sign(allParams as Record<string, string | number>)
  }

  const query = new URLSearchParams(
    Object.entries(allParams).map(([k, v]) => [k, String(v)])
  ).toString()

  const url = method === 'GET' || method === 'DELETE'
    ? `${BASE_URL}${path}?${query}`
    : `${BASE_URL}${path}`

  const body = method === 'POST' || method === 'PUT' ? query : undefined

  const res = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': API_KEY,
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

// ─── Public Endpoints ────────────────────────────────────────────────────────

export async function getKlines(
  symbol: TradingSymbol,
  interval: string,
  limit = 200
): Promise<Candle[]> {
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

export async function getAllPrices(): Promise<Record<string, number>> {
  type PriceTick = { symbol: string; price: string }
  const data = await request<PriceTick[]>('GET', '/fapi/v1/ticker/price')
  return Object.fromEntries(data.map((d) => [d.symbol, parseFloat(d.price)]))
}

export async function get24hTickers(symbols: TradingSymbol[]): Promise<Ticker[]> {
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

export async function getExchangeInfo(symbol: TradingSymbol): Promise<{
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
  type ExchangeInfo = { symbols: SymbolInfo[] }
  const data = await request<ExchangeInfo>('GET', '/fapi/v1/exchangeInfo')
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

// ─── Account Endpoints (Signed) ───────────────────────────────────────────────

export async function getAccountInfo(): Promise<AccountInfo> {
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
  const data = await request<RawAccount>('GET', '/fapi/v2/account', {}, true)
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

export async function getOpenOrders(symbol?: TradingSymbol): Promise<unknown[]> {
  const params: Record<string, string | number> = {}
  if (symbol) params.symbol = symbol
  return request<unknown[]>('GET', '/fapi/v1/openOrders', params, true)
}

// ─── Trading Endpoints (Signed) ───────────────────────────────────────────────

export async function setLeverage(symbol: TradingSymbol, leverage: number): Promise<void> {
  await request('POST', '/fapi/v1/leverage', { symbol, leverage }, true)
}

export async function setMarginType(symbol: TradingSymbol, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
  try {
    await request('POST', '/fapi/v1/marginType', { symbol, marginType }, true)
  } catch (e: unknown) {
    // "No need to change" error is ok
    if (!(e instanceof Error && e.message.includes('No need to change'))) throw e
  }
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

export async function placeOrder(params: PlaceOrderParams): Promise<OrderResponse> {
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

  return request<OrderResponse>('POST', '/fapi/v1/order', body, true)
}

export async function cancelOrder(symbol: TradingSymbol, orderId: number): Promise<void> {
  await request('DELETE', '/fapi/v1/order', { symbol, orderId }, true)
}

export async function cancelAllOrders(symbol: TradingSymbol): Promise<void> {
  await request('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true)
}

export async function closePosition(symbol: TradingSymbol, positionAmt: number, side: 'BUY' | 'SELL'): Promise<OrderResponse> {
  return placeOrder({
    symbol,
    side,
    type: 'MARKET',
    quantity: Math.abs(positionAmt),
    reduceOnly: true,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function roundQty(qty: number, precision: number): number {
  const factor = Math.pow(10, precision)
  return Math.floor(qty * factor) / factor
}

export function roundPrice(price: number, precision: number): number {
  const factor = Math.pow(10, precision)
  return Math.round(price * factor) / factor
}
