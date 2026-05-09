import type { Signal, Trade, AccountInfo, BotConfig, TradingSymbol } from '@/types/trading'
import { roundQty } from '@/lib/binance'

// ─── Position Sizing ──────────────────────────────────────────────────────────
// Formula: qty = (capital × riskPct) / (|entry - stopLoss| × leverage)
// This ensures we risk exactly riskPct% of capital per trade

export interface PositionSize {
  quantity: number
  riskAmount: number
  positionValue: number
  margin: number
}

export function calculatePositionSize(
  capital: number,
  riskPerTrade: number,
  entryPrice: number,
  stopLoss: number,
  leverage: number,
  qtyPrecision: number
): PositionSize {
  const riskAmount = capital * riskPerTrade
  const stopDistance = Math.abs(entryPrice - stopLoss)
  const stopDistancePct = stopDistance / entryPrice

  // Risk amount / (stop distance per contract adjusted for leverage)
  const rawQty = riskAmount / (stopDistance)
  const quantity = roundQty(rawQty, qtyPrecision)

  const positionValue = quantity * entryPrice
  const margin = positionValue / leverage

  return { quantity, riskAmount, positionValue, margin }
}

// ─── Risk Checks ──────────────────────────────────────────────────────────────

export interface RiskCheck {
  allowed: boolean
  reason?: string
}

export function checkCanOpenPosition(
  signal: Signal,
  openTrades: Trade[],
  account: AccountInfo,
  config: BotConfig,
  dailyLoss: number
): RiskCheck {
  // Max concurrent positions
  if (openTrades.length >= config.maxPositions) {
    return { allowed: false, reason: `Máx ${config.maxPositions} posiciones simultáneas alcanzado` }
  }

  // Already have position in this symbol
  const hasSymbol = openTrades.some((t) => t.symbol === signal.symbol && t.status === 'OPEN')
  if (hasSymbol) {
    return { allowed: false, reason: `Ya existe posición abierta en ${signal.symbol}` }
  }

  // Daily loss limit
  if (dailyLoss >= config.maxDailyLoss * config.currentCapital) {
    return { allowed: false, reason: `Límite de pérdida diaria alcanzado (${(config.maxDailyLoss * 100).toFixed(1)}%)` }
  }

  // Sufficient balance
  const requiredMargin = config.currentCapital * config.riskPerTrade * 2
  if (account.availableBalance < requiredMargin) {
    return { allowed: false, reason: `Balance insuficiente: $${account.availableBalance.toFixed(2)}` }
  }

  // Minimum signal strength
  if (signal.strength < 55) {
    return { allowed: false, reason: `Señal débil (strength: ${signal.strength}/100, mínimo: 55)` }
  }

  return { allowed: true }
}

// ─── Dynamic Stop Loss (Trailing) ─────────────────────────────────────────────

export function calculateTrailingStop(
  trade: Trade,
  currentPrice: number,
  atr: number
): number | null {
  if (!trade.tp1Hit) return null

  const direction = trade.side === 'BUY' ? 1 : -1
  const trailingDistance = atr * 1.0
  const newStop = currentPrice - direction * trailingDistance

  // Only move stop in favorable direction
  if (trade.side === 'BUY' && newStop > trade.stopLoss) return newStop
  if (trade.side === 'SELL' && newStop < trade.stopLoss) return newStop

  return null
}

// ─── Daily P&L Calculation ─────────────────────────────────────────────────────

export function calculateDailyLoss(trades: Trade[]): number {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  return trades
    .filter((t) => t.status === 'CLOSED' && new Date(t.closedAt || t.openedAt).getTime() > dayAgo)
    .reduce((sum, t) => sum + Math.min(0, t.pnl || 0), 0)
}

// ─── Kelly Criterion (position sizing reference) ───────────────────────────────
// f* = (W × P - L × (1-P)) / W
// W = average win ratio, L = average loss ratio, P = win probability

export function kellyCriterion(winRate: number, avgWin: number, avgLoss: number): number {
  if (avgLoss === 0) return 0
  const W = avgWin / avgLoss
  const P = winRate / 100
  const kelly = (W * P - (1 - P)) / W
  // Use half-Kelly for safety
  return Math.max(0, Math.min(0.05, kelly * 0.5))
}

// ─── Risk/Reward Validation ───────────────────────────────────────────────────

export function validateRiskReward(
  entry: number,
  stopLoss: number,
  takeProfit: number,
  side: 'BUY' | 'SELL',
  minRR = 1.5
): boolean {
  const risk = Math.abs(entry - stopLoss)
  const reward = Math.abs(takeProfit - entry)
  if (risk === 0) return false
  const rr = reward / risk
  return rr >= minRR
}

// ─── Max Drawdown Check ───────────────────────────────────────────────────────

export function exceedsMaxDrawdown(
  currentCapital: number,
  initialCapital: number,
  maxDrawdownPct = 0.15
): boolean {
  const drawdown = (initialCapital - currentCapital) / initialCapital
  return drawdown >= maxDrawdownPct
}

// ─── Exposure Calculation ─────────────────────────────────────────────────────

export function getTotalExposure(positions: { quantity: number; entryPrice: number; leverage: number }[]): number {
  return positions.reduce((sum, p) => sum + p.quantity * p.entryPrice, 0)
}

export function getSymbolQtyPrecision(symbol: TradingSymbol): number {
  const map: Record<TradingSymbol, number> = {
    BTCUSDT: 3, ETHUSDT: 3, SOLUSDT: 1, BNBUSDT: 2, XRPUSDT: 0,
  }
  return map[symbol]
}
