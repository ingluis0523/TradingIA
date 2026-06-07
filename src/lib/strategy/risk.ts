import type { Signal, Trade, AccountInfo, BotConfig, TradingSymbol } from '@/types/trading'
import { roundQty } from '@/lib/binance'

// ─── Position Sizing ──────────────────────────────────────────────────────────
// Formula: qty = (capital × riskPct) / |entry - stopLoss|
// Risks exactly riskPct% of capital per trade.

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
  const quantity = roundQty(riskAmount / stopDistance, qtyPrecision)
  const positionValue = quantity * entryPrice
  const margin = positionValue / leverage
  return { quantity, riskAmount, positionValue, margin }
}

// ─── Daily P&L Calculation ────────────────────────────────────────────────────

export interface DailyLossSnapshot {
  realizedLoss: number      // absolute value of closed losing trades in last 24h
  unrealizedLoss: number    // absolute value of open position unrealized losses
  totalLoss: number         // realizedLoss + unrealizedLoss
}

// B9 fix: now includes unrealized PnL from open positions.
// openPositions defaults to [] so existing callers remain compatible.
export function calculateDailyLoss(
  trades: Trade[],
  openPositions: { symbol: string; unrealizedPnl: number }[] = []
): DailyLossSnapshot {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000

  const realizedLoss = trades
    .filter(
      (t) =>
        t.status === 'CLOSED' &&
        (t.pnl ?? 0) < 0 &&
        new Date(t.closedAt || t.openedAt).getTime() > dayAgo
    )
    .reduce((sum, t) => sum + Math.abs(t.pnl ?? 0), 0)

  const unrealizedLoss = openPositions
    .filter((p) => p.unrealizedPnl < 0)
    .reduce((sum, p) => sum + Math.abs(p.unrealizedPnl), 0)

  return { realizedLoss, unrealizedLoss, totalLoss: realizedLoss + unrealizedLoss }
}

// ─── Risk Checks ──────────────────────────────────────────────────────────────

export interface RiskCheck {
  allowed: boolean
  reason?: string
}

// dailyLoss accepts DailyLossSnapshot (new) or number (legacy callers passing raw sum).
// B3 fix: when a number is passed, the old code compared a negative loss against a
// positive threshold (always false). Fixed by extracting the absolute loss value.
export function checkCanOpenPosition(
  signal: Signal,
  openTrades: Trade[],
  account: AccountInfo,
  config: BotConfig,
  dailyLoss: DailyLossSnapshot | number
): RiskCheck {
  if (openTrades.length >= config.maxPositions) {
    return { allowed: false, reason: `Máx ${config.maxPositions} posiciones simultáneas alcanzado` }
  }

  if (openTrades.some((t) => t.symbol === signal.symbol && t.status === 'OPEN')) {
    return { allowed: false, reason: `Ya existe posición abierta en ${signal.symbol}` }
  }

  const totalLoss =
    typeof dailyLoss === 'number'
      ? Math.abs(Math.min(0, dailyLoss))  // legacy: negative sum → positive loss
      : dailyLoss.totalLoss
  if (totalLoss >= config.maxDailyLoss * config.currentCapital) {
    return {
      allowed: false,
      reason: `Límite de pérdida diaria alcanzado (${(config.maxDailyLoss * 100).toFixed(1)}%)`,
    }
  }

  const requiredMargin = config.currentCapital * config.riskPerTrade * 2
  if (account.availableBalance < requiredMargin) {
    return { allowed: false, reason: `Balance insuficiente: $${account.availableBalance.toFixed(2)}` }
  }

  // 4.3: raised from 52 to 60; configurable via user_bot_config in phase 2
  if (signal.strength < 60) {
    return { allowed: false, reason: `Señal débil (strength: ${signal.strength}/100, mínimo: 60)` }
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
  const newStop = currentPrice - direction * atr

  if (trade.side === 'BUY' && newStop > trade.stopLoss) return newStop
  if (trade.side === 'SELL' && newStop < trade.stopLoss) return newStop

  return null
}

// ─── Risk/Reward Validation ───────────────────────────────────────────────────

export function validateRiskReward(
  entry: number,
  stopLoss: number,
  takeProfit: number,
  _side: 'BUY' | 'SELL',
  minRR = 1.5
): boolean {
  const risk = Math.abs(entry - stopLoss)
  const reward = Math.abs(takeProfit - entry)
  if (risk === 0) return false
  return reward / risk >= minRR
}

// ─── Max Drawdown Check ───────────────────────────────────────────────────────

export function exceedsMaxDrawdown(
  currentCapital: number,
  initialCapital: number,
  maxDrawdownPct = 0.15
): boolean {
  return (initialCapital - currentCapital) / initialCapital >= maxDrawdownPct
}

// ─── Exposure Calculation ─────────────────────────────────────────────────────

export function getTotalExposure(
  positions: { quantity: number; entryPrice: number; leverage: number }[]
): number {
  return positions.reduce((sum, p) => sum + p.quantity * p.entryPrice, 0)
}

export function getSymbolQtyPrecision(symbol: TradingSymbol): number {
  const map: Record<TradingSymbol, number> = {
    BTCUSDT: 3, ETHUSDT: 3, SOLUSDT: 1, BNBUSDT: 2, XRPUSDT: 0,
  }
  return map[symbol]
}

// ─── Kelly Criterion (removed) ────────────────────────────────────────────────
// TODO fase 5: implementar como feature opcional para position sizing dinámico
//   basado en win rate del usuario (half-Kelly sobre ventana de últimos N trades).
