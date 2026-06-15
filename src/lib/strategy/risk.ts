import type { Signal, Trade, AccountInfo, BotConfig, TradingSymbol } from '@/types/trading'
import { roundQty } from '@/lib/binance'

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
// Escalated response to drawdown — replaces the blunt 24h PAUSE_ALL.
//
// Tier 1 — 2 consecutive losses            → reduce size to 50% until next win
// Tier 2 — 3 consecutive in same direction → pause that direction 6h, keep the other
// Tier 3 — daily loss ≥ maxDailyLoss       → pause everything until tomorrow UTC

export interface CircuitBreakerState {
  consecutiveLosses: number
  dailyLossPct: number
  action: 'NONE' | 'REDUCE_SIZE' | 'PAUSE_DIRECTION' | 'PAUSE_ALL'
  sizeMultiplier: number        // 1.0 = normal, 0.5 = half, 0 = paused
  pausedDirection?: 'LONG' | 'SHORT'
  pauseUntil?: Date
  reason: string
}

/**
 * Pure function — recomputed each tick from the last-24h closed trades.
 * No DB state required; direction pause expires naturally when pauseUntil passes.
 *
 * @param closedTrades   CLOSED trades from the last 24h (already filtered by shadow mode)
 * @param maxDailyLoss   Fraction of capital, e.g. 0.05 for 5%
 * @param allocatedCapital  USD value of the trading allocation
 */
export function evaluateCircuitBreaker(
  closedTrades: Trade[],
  maxDailyLoss: number,
  allocatedCapital: number,
): CircuitBreakerState {
  // Sort most-recent first
  const sorted = [...closedTrades].sort(
    (a, b) => new Date(b.closedAt!).getTime() - new Date(a.closedAt!).getTime(),
  )

  // Count consecutive losses from the most recent trade
  let consecutiveLosses = 0
  for (const t of sorted) {
    if ((t.pnl ?? 0) < 0) consecutiveLosses++
    else break
  }

  // Daily loss: sum of absolute losses in the window
  const dailyLossAbs = closedTrades
    .filter((t) => (t.pnl ?? 0) < 0)
    .reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0)
  const dailyLossPct = allocatedCapital > 0 ? dailyLossAbs / allocatedCapital : 0

  // ── Tier 3: total daily loss ─────────────────────────────────────────────
  if (dailyLossPct >= maxDailyLoss) {
    const tomorrow = new Date()
    tomorrow.setUTCHours(24, 0, 0, 0)
    return {
      consecutiveLosses,
      dailyLossPct,
      action: 'PAUSE_ALL',
      sizeMultiplier: 0,
      pauseUntil: tomorrow,
      reason: `Pérdida diaria ${(dailyLossPct * 100).toFixed(1)}% alcanzó el límite ${(maxDailyLoss * 100).toFixed(0)}%`,
    }
  }

  // ── Tier 2: 3 consecutive losses, same direction ─────────────────────────
  if (consecutiveLosses >= 3) {
    const lastDir = sorted[0].side === 'BUY' ? 'LONG' : 'SHORT'
    const sameDir = sorted
      .slice(0, 3)
      .every((t) => (t.side === 'BUY' ? 'LONG' : 'SHORT') === lastDir)

    if (sameDir) {
      // Pause expires 6h from when the 3rd loss was closed (not from "now")
      const thirdLossTime = new Date(sorted[2].closedAt!).getTime()
      const pauseUntil = new Date(thirdLossTime + 6 * 3600 * 1000)
      return {
        consecutiveLosses,
        dailyLossPct,
        action: 'PAUSE_DIRECTION',
        sizeMultiplier: 0.5,
        pausedDirection: lastDir,
        pauseUntil,
        reason: `3 pérdidas seguidas en ${lastDir}. Pausando ${lastDir} hasta ${pauseUntil.toISOString()}; dirección opuesta sigue activa.`,
      }
    }
  }

  // ── Tier 1: 2 consecutive losses (any direction) ─────────────────────────
  if (consecutiveLosses >= 2) {
    return {
      consecutiveLosses,
      dailyLossPct,
      action: 'REDUCE_SIZE',
      sizeMultiplier: 0.5,
      reason: `${consecutiveLosses} pérdidas seguidas. Reduciendo tamaño al 50% hasta la próxima ganancia.`,
    }
  }

  return { consecutiveLosses, dailyLossPct, action: 'NONE', sizeMultiplier: 1.0, reason: 'Normal' }
}

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
