export type TradingSymbol = 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT' | 'BNBUSDT' | 'XRPUSDT'

export type OrderSide = 'BUY' | 'SELL'
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'
export type PositionSide = 'LONG' | 'SHORT' | 'BOTH'
export type TradeStatus = 'OPEN' | 'CLOSED' | 'CANCELLED' | 'PARTIAL'
export type SignalType = 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD'
export type BotStatus = 'RUNNING' | 'STOPPED' | 'ERROR' | 'PAUSED'
export type MarginType = 'ISOLATED' | 'CROSSED'

export interface Candle {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  closeTime: number
}

export interface Ticker {
  symbol: TradingSymbol
  price: number
  change24h: number
  changePct24h: number
  high24h: number
  low24h: number
  volume24h: number
  lastUpdate: number
}

export interface Indicators {
  ema20: number
  ema50: number
  ema200: number
  rsi14: number
  macdLine: number
  macdSignal: number
  macdHistogram: number
  atr14: number
  bbUpper: number
  bbMiddle: number
  bbLower: number
  superTrend: number
  superTrendDirection: 'UP' | 'DOWN'
  volumeSMA20: number
  adx14: number
}

export interface Signal {
  id?: string
  symbol: TradingSymbol
  type: SignalType
  strength: number
  price: number
  stopLoss: number
  takeProfit1: number
  takeProfit2: number
  indicators: Indicators
  reason: string
  timestamp: number
  executed: boolean
}

export interface Trade {
  id: string
  symbol: TradingSymbol
  side: OrderSide
  status: TradeStatus
  entryPrice: number
  exitPrice?: number
  quantity: number
  leverage: number
  stopLoss: number
  takeProfit1: number
  takeProfit2: number
  tp1Hit: boolean
  pnl?: number
  pnlPct?: number
  fee: number
  duration?: number
  binanceOrderId?: string
  stopOrderId?: string
  tp1OrderId?: string
  tp2OrderId?: string
  openedAt: string
  closedAt?: string
  signal?: Partial<Signal>
  notes?: string
}

export interface Position {
  symbol: TradingSymbol
  positionAmt: number
  entryPrice: number
  markPrice: number
  unrealizedPnl: number
  leverage: number
  marginType: MarginType
  liquidationPrice: number
  positionSide: PositionSide
}

export interface AccountInfo {
  totalBalance: number
  availableBalance: number
  totalUnrealizedPnl: number
  totalMarginBalance: number
  positions: Position[]
}

export interface BotConfig {
  id?: string
  isRunning: boolean
  symbols: TradingSymbol[]
  leverage: number
  riskPerTrade: number
  maxPositions: number
  maxDailyLoss: number
  initialCapital: number
  currentCapital: number
  marginType: MarginType
  strategy: string
  timeframe: string
  updatedAt?: string
}

export interface PerformanceMetrics {
  totalTrades: number
  winRate: number
  totalPnl: number
  totalPnlPct: number
  weeklyPnl: number
  weeklyPnlPct: number
  dailyPnl: number
  dailyPnlPct: number
  maxDrawdown: number
  sharpeRatio: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  bestTrade: number
  worstTrade: number
  consecutiveWins: number
  consecutiveLosses: number
}

export interface BotLog {
  id?: string
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'TRADE'
  message: string
  data?: Record<string, unknown>
  timestamp: string
}

export interface PriceAlert {
  id?: string
  symbol: TradingSymbol
  condition: 'ABOVE' | 'BELOW'
  price: number
  triggered: boolean
  createdAt?: string
}

export interface IndicatorConfig {
  ema20Period: number
  ema50Period: number
  ema200Period: number
  rsiPeriod: number
  macdFast: number
  macdSlow: number
  macdSignal: number
  atrPeriod: number
  bbPeriod: number
  bbStdDev: number
  superTrendPeriod: number
  superTrendMultiplier: number
  adxPeriod: number
}

export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = {
  ema20Period: 20,
  ema50Period: 50,
  ema200Period: 200,
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  atrPeriod: 14,
  bbPeriod: 20,
  bbStdDev: 2,
  superTrendPeriod: 7,
  superTrendMultiplier: 3,
  adxPeriod: 14,
}

export const TRADING_SYMBOLS: TradingSymbol[] = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
]

export const SYMBOL_INFO: Record<TradingSymbol, { name: string; icon: string; minQty: number; qtyPrecision: number; pricePrecision: number }> = {
  BTCUSDT:  { name: 'Bitcoin',  icon: '₿',  minQty: 0.001, qtyPrecision: 3, pricePrecision: 1 },
  ETHUSDT:  { name: 'Ethereum', icon: 'Ξ',  minQty: 0.001, qtyPrecision: 3, pricePrecision: 2 },
  SOLUSDT:  { name: 'Solana',   icon: '◎',  minQty: 0.1,   qtyPrecision: 1, pricePrecision: 3 },
  BNBUSDT:  { name: 'BNB',      icon: 'B',  minQty: 0.01,  qtyPrecision: 2, pricePrecision: 2 },
  XRPUSDT:  { name: 'XRP',      icon: 'X',  minQty: 1,     qtyPrecision: 0, pricePrecision: 4 },
}
