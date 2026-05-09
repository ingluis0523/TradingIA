-- ═══════════════════════════════════════════════════════════
--  TradingIA — Supabase Schema
--  Ejecuta este script en el SQL Editor de Supabase
-- ═══════════════════════════════════════════════════════════

-- ─── Bot Configuration ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_config (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  is_running    BOOLEAN NOT NULL DEFAULT false,
  symbols       TEXT[]  NOT NULL DEFAULT ARRAY['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'],
  leverage      INTEGER NOT NULL DEFAULT 3,
  risk_per_trade DECIMAL(5,4) NOT NULL DEFAULT 0.02,
  max_positions INTEGER NOT NULL DEFAULT 3,
  max_daily_loss DECIMAL(5,4) NOT NULL DEFAULT 0.05,
  initial_capital DECIMAL(12,4) NOT NULL DEFAULT 1000,
  current_capital DECIMAL(12,4) NOT NULL DEFAULT 1000,
  margin_type   TEXT    NOT NULL DEFAULT 'ISOLATED',
  strategy      TEXT    NOT NULL DEFAULT 'AMSS',
  timeframe     TEXT    NOT NULL DEFAULT '1h',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Insert default config
INSERT INTO bot_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─── Trades ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol            TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED', 'PARTIAL')),
  entry_price       DECIMAL(20,8) NOT NULL,
  exit_price        DECIMAL(20,8),
  quantity          DECIMAL(20,8) NOT NULL,
  leverage          INTEGER NOT NULL DEFAULT 3,
  stop_loss         DECIMAL(20,8) NOT NULL,
  take_profit1      DECIMAL(20,8) NOT NULL,
  take_profit2      DECIMAL(20,8) NOT NULL,
  tp1_hit           BOOLEAN NOT NULL DEFAULT false,
  pnl               DECIMAL(20,8),
  pnl_pct           DECIMAL(10,4),
  fee               DECIMAL(20,8) NOT NULL DEFAULT 0,
  duration          BIGINT,
  binance_order_id  TEXT,
  stop_order_id     TEXT,
  tp1_order_id      TEXT,
  tp2_order_id      TEXT,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS trades_status_idx ON trades (status);
CREATE INDEX IF NOT EXISTS trades_symbol_idx ON trades (symbol);
CREATE INDEX IF NOT EXISTS trades_opened_at_idx ON trades (opened_at DESC);

-- ─── Signals ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('LONG', 'SHORT', 'CLOSE', 'HOLD')),
  strength    INTEGER NOT NULL CHECK (strength BETWEEN 0 AND 100),
  price       DECIMAL(20,8) NOT NULL,
  stop_loss   DECIMAL(20,8) NOT NULL,
  take_profit1 DECIMAL(20,8) NOT NULL,
  take_profit2 DECIMAL(20,8) NOT NULL,
  indicators  JSONB,
  reason      TEXT,
  executed    BOOLEAN NOT NULL DEFAULT false,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS signals_timestamp_idx ON signals (timestamp DESC);
CREATE INDEX IF NOT EXISTS signals_symbol_idx ON signals (symbol);

-- ─── Bot Logs ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_logs (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level     TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'ERROR', 'SUCCESS', 'TRADE')),
  message   TEXT NOT NULL,
  data      JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bot_logs_timestamp_idx ON bot_logs (timestamp DESC);

-- Auto-cleanup: keep only last 7 days of logs
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM bot_logs WHERE timestamp < NOW() - INTERVAL '7 days';
  DELETE FROM signals WHERE timestamp < NOW() - INTERVAL '30 days';
$$;

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- Note: For now we use the service role key in the backend (full access)
-- Enable RLS only if you want to add user authentication later

-- ALTER TABLE bot_config ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE signals ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE bot_logs ENABLE ROW LEVEL SECURITY;

-- ─── Real-time Subscriptions ──────────────────────────────────────────────────
-- Enable real-time for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE trades;
ALTER PUBLICATION supabase_realtime ADD TABLE bot_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE signals;
