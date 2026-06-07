import { createClient } from '@supabase/supabase-js'
import type { BotConfig, BotLog, Trade, Signal, PerformanceMetrics, UserBotConfig } from '@/types/trading'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Client for browser use (limited permissions)
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

export const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || '00000000-0000-0000-0000-000000000001'

// Client for server use (full permissions)
// custom fetch disables Next.js data cache so queries always return fresh data
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: {
    fetch: (url: RequestInfo | URL, init?: RequestInit) =>
      fetch(url, { ...init, cache: 'no-store' }),
  },
})

// ─── Bot Config ─────────────────────────────────────────────────────────────

export async function getBotConfig(): Promise<BotConfig | null> {
  const { data, error } = await supabaseAdmin
    .from('bot_config')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single()
  if (error) return null
  return mapBotConfig(data)
}

export async function updateBotConfig(config: Partial<BotConfig>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('bot_config')
    .upsert({ id: 1, ...mapBotConfigToDb(config), updated_at: new Date().toISOString() })
  if (error) throw error
}

// ─── Trades ──────────────────────────────────────────────────────────────────

export async function createTrade(trade: Omit<Trade, 'id'>): Promise<Trade> {
  const { data, error } = await supabaseAdmin
    .from('trades')
    .insert(mapTradeToDb(trade))
    .select()
    .single()
  if (error) throw error
  return mapTrade(data)
}

export async function updateTrade(id: string, updates: Partial<Trade>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('trades')
    .update(mapTradeToDb(updates))
    .eq('id', id)
  if (error) throw error
}

export async function getOpenTrades(): Promise<Trade[]> {
  const { data, error } = await supabaseAdmin
    .from('trades')
    .select('*')
    .eq('status', 'OPEN')
    .order('opened_at', { ascending: false })
  if (error) throw error
  return (data || []).map(mapTrade)
}

export async function getRecentTrades(limit = 50): Promise<Trade[]> {
  const { data, error } = await supabaseAdmin
    .from('trades')
    .select('*')
    .order('opened_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data || []).map(mapTrade)
}

export async function getTradesInRange(from: string, to: string): Promise<Trade[]> {
  const { data, error } = await supabaseAdmin
    .from('trades')
    .select('*')
    .gte('opened_at', from)
    .lte('opened_at', to)
    .order('opened_at', { ascending: false })
  if (error) throw error
  return (data || []).map(mapTrade)
}

// ─── Signals ─────────────────────────────────────────────────────────────────

export async function saveSignal(signal: Omit<Signal, 'id'>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('signals')
    .insert({
      symbol: signal.symbol,
      type: signal.type,
      strength: signal.strength,
      price: signal.price,
      stop_loss: signal.stopLoss,
      take_profit1: signal.takeProfit1,
      take_profit2: signal.takeProfit2,
      indicators: signal.indicators,
      reason: signal.reason,
      executed: signal.executed,
      timestamp: new Date(signal.timestamp).toISOString(),
    })
  if (error) console.error('Error saving signal:', error)
}

export async function getRecentSignals(limit = 30): Promise<Signal[]> {
  const { data, error } = await supabaseAdmin
    .from('signals')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(limit)
  if (error) return []
  return (data || []).map((s) => ({
    id: s.id,
    symbol: s.symbol,
    type: s.type,
    strength: s.strength,
    price: s.price,
    stopLoss: s.stop_loss,
    takeProfit1: s.take_profit1,
    takeProfit2: s.take_profit2,
    indicators: s.indicators,
    reason: s.reason,
    executed: s.executed,
    timestamp: new Date(s.timestamp).getTime(),
  }))
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export async function addLog(log: Omit<BotLog, 'id'>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('bot_logs')
    .insert({
      level: log.level,
      message: log.message,
      data: log.data || null,
      timestamp: log.timestamp,
    })
  if (error) console.error('Error adding log:', error)
}

export async function getRecentLogs(limit = 100): Promise<BotLog[]> {
  const { data, error } = await supabaseAdmin
    .from('bot_logs')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(limit)
  if (error) return []
  return (data || []).map((l) => ({
    id: l.id,
    level: l.level,
    message: l.message,
    data: l.data,
    timestamp: l.timestamp,
  }))
}

// ─── Performance ─────────────────────────────────────────────────────────────

export async function getPerformanceMetrics(): Promise<PerformanceMetrics> {
  const trades = await getRecentTrades(500)
  const closedTrades = trades.filter((t) => t.status === 'CLOSED')
  const now = Date.now()
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000
  const dayAgo = now - 24 * 60 * 60 * 1000

  const weeklyTrades = closedTrades.filter((t) => new Date(t.openedAt).getTime() > weekAgo)
  const dailyTrades = closedTrades.filter((t) => new Date(t.openedAt).getTime() > dayAgo)

  const wins = closedTrades.filter((t) => (t.pnl || 0) > 0)
  const losses = closedTrades.filter((t) => (t.pnl || 0) <= 0)

  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0)
  const weeklyPnl = weeklyTrades.reduce((s, t) => s + (t.pnl || 0), 0)
  const dailyPnl = dailyTrades.reduce((s, t) => s + (t.pnl || 0), 0)
  const initialCapital = Number(process.env.BOT_INITIAL_CAPITAL || 1000)

  const grossProfit = wins.reduce((s, t) => s + (t.pnl || 0), 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0))

  let maxDrawdown = 0
  let peak = initialCapital
  let running = initialCapital
  for (const t of closedTrades.slice().reverse()) {
    running += t.pnl || 0
    if (running > peak) peak = running
    const dd = (peak - running) / peak
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  let consWins = 0, consLosses = 0, curW = 0, curL = 0
  for (const t of closedTrades) {
    if ((t.pnl || 0) > 0) { curW++; curL = 0 }
    else { curL++; curW = 0 }
    if (curW > consWins) consWins = curW
    if (curL > consLosses) consLosses = curL
  }

  return {
    totalTrades: closedTrades.length,
    winRate: closedTrades.length ? (wins.length / closedTrades.length) * 100 : 0,
    totalPnl,
    totalPnlPct: (totalPnl / initialCapital) * 100,
    weeklyPnl,
    weeklyPnlPct: (weeklyPnl / initialCapital) * 100,
    dailyPnl,
    dailyPnlPct: (dailyPnl / initialCapital) * 100,
    maxDrawdown: maxDrawdown * 100,
    sharpeRatio: calculateSharpeRatio(closedTrades),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    bestTrade: closedTrades.length ? Math.max(...closedTrades.map((t) => t.pnl || 0)) : 0,
    worstTrade: closedTrades.length ? Math.min(...closedTrades.map((t) => t.pnl || 0)) : 0,
    consecutiveWins: consWins,
    consecutiveLosses: consLosses,
  }
}

function calculateSharpeRatio(trades: Trade[]): number {
  if (trades.length < 2) return 0
  const returns = trades.map((t) => t.pnlPct || 0)
  const avg = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / returns.length
  const stdDev = Math.sqrt(variance)
  return stdDev > 0 ? (avg / stdDev) * Math.sqrt(52) : 0
}

// ─── Multi-Tenant Engine Support ─────────────────────────────────────────────

export async function isGlobalKillSwitchActive(): Promise<boolean> {
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

export async function setGlobalKillSwitch(active: boolean, reason?: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('global_kill_switch')
    .insert({ is_active: active, reason: reason ?? null, activated_at: new Date().toISOString() })
  if (error) throw error
}

export async function getActiveTradingUsers(): Promise<{ id: string }[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_bot_config')
      .select('user_id')
      .eq('is_running', true)
    if (error || !data || data.length === 0) return [{ id: SYSTEM_USER_ID }]
    return data.map((r) => ({ id: r.user_id as string }))
  } catch {
    return [{ id: SYSTEM_USER_ID }]
  }
}

export async function getUserBotConfig(userId: string): Promise<UserBotConfig | null> {
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

export async function updateUserBotConfig(
  userId: string,
  updates: Partial<Omit<UserBotConfig, 'userId' | 'updatedAt'>>,
): Promise<void> {
  const db: Record<string, unknown> = {
    user_id: userId,
    updated_at: new Date().toISOString(),
  }
  if (updates.isRunning !== undefined) db.is_running = updates.isRunning
  if (updates.symbols !== undefined) db.symbols = updates.symbols
  if (updates.leverage !== undefined) db.leverage = updates.leverage
  if (updates.riskPerTrade !== undefined) db.risk_per_trade = updates.riskPerTrade
  if (updates.maxPositions !== undefined) db.max_positions = updates.maxPositions
  if (updates.maxDailyLoss !== undefined) db.max_daily_loss = updates.maxDailyLoss
  if (updates.tradingAllocationPct !== undefined) db.trading_allocation_pct = updates.tradingAllocationPct
  if (updates.strategy !== undefined) db.strategy = updates.strategy
  if (updates.timeframe !== undefined) db.timeframe = updates.timeframe
  if (updates.minSignalStrength !== undefined) db.min_signal_strength = updates.minSignalStrength
  if (updates.pausedUntil !== undefined) db.paused_until = updates.pausedUntil
  if (updates.pausedReason !== undefined) db.paused_reason = updates.pausedReason

  const { error } = await supabaseAdmin
    .from('user_bot_config')
    .upsert(db, { onConflict: 'user_id' })
  if (error) throw error
}

export async function pauseUserUntil(userId: string, until: string, reason: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('user_bot_config')
    .update({ paused_until: until, paused_reason: reason, is_running: false })
    .eq('user_id', userId)
  if (error) throw error
}

export async function getOpenTradesForUser(userId: string): Promise<Trade[]> {
  const { data, error } = await supabaseAdmin
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['OPEN', 'PENDING'])
    .order('opened_at', { ascending: false })
  if (error) throw error
  return (data || []).map(mapTrade)
}

export async function getRecentTradesForUser(userId: string, limit: number): Promise<Trade[]> {
  const { data, error } = await supabaseAdmin
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .order('opened_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data || []).map(mapTrade)
}

export async function addLogForUser(
  userId: string,
  log: Omit<BotLog, 'id'>,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('bot_logs')
    .insert({
      user_id: userId,
      level: log.level,
      message: log.message,
      data: log.data ?? null,
      timestamp: log.timestamp,
    })
  if (error) console.error('Error adding user log:', error)
}

export async function getOrCreateDailyCapitalSnapshot(
  userId: string,
  date: string,
  initialCapital: number,
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('user_capital_snapshots')
    .select('initial_capital')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle()
  if (error) throw error
  if (data) return data.initial_capital as number

  const { error: insertError } = await supabaseAdmin
    .from('user_capital_snapshots')
    .insert({ user_id: userId, date, initial_capital: initialCapital })
  if (insertError) throw insertError

  return initialCapital
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapTrade(row: Record<string, unknown>): Trade {
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
    fee: row.fee as number,
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
    isShadow: (row.is_shadow as boolean) ?? false,
  }
}

function mapTradeToDb(trade: Partial<Trade>): Record<string, unknown> {
  const db: Record<string, unknown> = {}
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
  if (trade.userId !== undefined) db.user_id = trade.userId
  if (trade.clientOrderId !== undefined) db.client_order_id = trade.clientOrderId
  if (trade.actualEntryPrice !== undefined) db.actual_entry_price = trade.actualEntryPrice
  if (trade.actualExitPrice !== undefined) db.actual_exit_price = trade.actualExitPrice
  if (trade.realizedPnlBinance !== undefined) db.realized_pnl_binance = trade.realizedPnlBinance
  if (trade.isShadow !== undefined) db.is_shadow = trade.isShadow
  return db
}

function mapBotConfig(row: Record<string, unknown>): BotConfig {
  return {
    id: row.id as string,
    isRunning: row.is_running as boolean,
    symbols: row.symbols as BotConfig['symbols'],
    leverage: row.leverage as number,
    riskPerTrade: row.risk_per_trade as number,
    maxPositions: row.max_positions as number,
    maxDailyLoss: row.max_daily_loss as number,
    initialCapital: row.initial_capital as number,
    currentCapital: row.current_capital as number,
    marginType: row.margin_type as BotConfig['marginType'],
    strategy: row.strategy as string,
    timeframe: row.timeframe as string,
    updatedAt: row.updated_at as string,
  }
}

function mapBotConfigToDb(config: Partial<BotConfig>): Record<string, unknown> {
  const db: Record<string, unknown> = {}
  if (config.isRunning !== undefined) db.is_running = config.isRunning
  if (config.symbols !== undefined) db.symbols = config.symbols
  if (config.leverage !== undefined) db.leverage = config.leverage
  if (config.riskPerTrade !== undefined) db.risk_per_trade = config.riskPerTrade
  if (config.maxPositions !== undefined) db.max_positions = config.maxPositions
  if (config.maxDailyLoss !== undefined) db.max_daily_loss = config.maxDailyLoss
  if (config.initialCapital !== undefined) db.initial_capital = config.initialCapital
  if (config.currentCapital !== undefined) db.current_capital = config.currentCapital
  if (config.marginType !== undefined) db.margin_type = config.marginType
  if (config.strategy !== undefined) db.strategy = config.strategy
  if (config.timeframe !== undefined) db.timeframe = config.timeframe
  return db
}
