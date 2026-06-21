-- Migration 005: update user_bot_config for Merino strategy
-- Symbols: BTC/BNB/ADA/DOT (validated universe, ETH/SOL/XRP removed)
-- Timeframe: 4h (Merino operates on 4h candles only)
-- SL/TP: validated backtest-optimal multipliers (2020-2026, train/test split)

-- Add timeframe column if it doesn't exist yet
alter table user_bot_config
  add column if not exists timeframe text not null default '4h';

-- Update all rows to Merino parameters
update user_bot_config
set
  symbols       = array['BTCUSDT', 'BNBUSDT', 'ADAUSDT', 'DOTUSDT'],
  timeframe     = '4h',
  sl_atr_mult   = 2.5,
  tp1_atr_mult  = 3.0,
  tp2_atr_mult  = 6.0,
  updated_at    = now();
