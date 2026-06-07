-- ============================================================
-- Migración 001: Multi-Tenant Foundation
-- Fase 1 — Sección 2 del spec 01_PHASE_1_FOUNDATION.md
--
-- IMPORTANTE: ejecutar con el bot DETENIDO en producción.
-- bot_config NO se elimina en esta migración (ver sección 2.4).
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 2.1 Nuevas tablas
-- ─────────────────────────────────────────────────────────────

-- Usuarios del sistema (incluye admin y traders)
-- En fase 1 solo existe el "system user"; integración con Supabase Auth viene en fase 2.
create table if not exists app_users (
  id              uuid primary key default gen_random_uuid(),
  email           text unique not null,
  display_name    text,
  role            text not null check (role in ('admin', 'trader', 'system')),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Configuración del bot por usuario (reemplaza la singleton bot_config)
create table if not exists user_bot_config (
  user_id                 uuid primary key references app_users(id) on delete cascade,
  is_running              boolean not null default false,
  symbols                 text[] not null default array['BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT'],
  leverage                integer not null default 3 check (leverage between 1 and 10),
  risk_per_trade          numeric(5,4) not null default 0.02 check (risk_per_trade between 0.005 and 0.05),
  max_positions           integer not null default 3 check (max_positions between 1 and 5),
  max_daily_loss          numeric(5,4) not null default 0.05 check (max_daily_loss between 0.02 and 0.10),
  trading_allocation_pct  numeric(5,4) not null default 0.50 check (trading_allocation_pct between 0.10 and 1.00),
  margin_type             text not null default 'ISOLATED' check (margin_type = 'ISOLATED'),
  strategy                text not null default 'AMSS',
  timeframe               text not null default '1h',
  min_signal_strength     integer not null default 60 check (min_signal_strength between 50 and 100),
  paused_until            timestamptz,  -- pausa temporal automática por daily loss
  paused_reason           text,
  updated_at              timestamptz not null default now()
);

-- Snapshot del capital asignado al inicio del día (para cálculos de % daily loss)
create table if not exists user_capital_snapshots (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references app_users(id) on delete cascade,
  snapshot_date     date not null,
  binance_balance   numeric(20,8) not null,
  allocated_capital numeric(20,8) not null,
  created_at        timestamptz not null default now(),
  unique (user_id, snapshot_date)
);

-- Kill switch global
create table if not exists global_kill_switch (
  id            integer primary key default 1 check (id = 1),
  is_active     boolean not null default false,
  activated_by  uuid references app_users(id),
  activated_at  timestamptz,
  reason        text,
  updated_at    timestamptz not null default now()
);
insert into global_kill_switch (id, is_active) values (1, false) on conflict (id) do nothing;

-- Lock para cron concurrente (usado en fase 3, pero la tabla se crea ya)
create table if not exists cron_locks (
  lock_name   text primary key,
  locked_at   timestamptz not null,
  locked_by   text not null,  -- identificador del invocador (ej: invocation_id)
  expires_at  timestamptz not null
);

-- ─────────────────────────────────────────────────────────────
-- 2.2 Modificar tablas existentes (añadir user_id)
-- ─────────────────────────────────────────────────────────────

-- trades: añadir user_id y columnas para PnL real desde Binance
alter table trades
  add column if not exists user_id               uuid references app_users(id) on delete restrict,
  add column if not exists client_order_id       text,
  add column if not exists actual_entry_price    numeric(20,8),  -- desde userTrades de Binance
  add column if not exists actual_exit_price     numeric(20,8),  -- desde userTrades de Binance
  add column if not exists realized_pnl_binance  numeric(20,8);  -- PnL real de Binance, no calculado

create index if not exists trades_user_id_idx on trades (user_id);
create index if not exists trades_client_order_id_idx on trades (client_order_id) where client_order_id is not null;

-- bot_logs: añadir user_id (puede ser null para logs del sistema)
alter table bot_logs
  add column if not exists user_id uuid references app_users(id) on delete set null;
create index if not exists bot_logs_user_id_idx on bot_logs (user_id);

-- signals: NO se añade user_id (las señales son compartidas).
-- Añadir timestamp de candle close para tracking de duplicados.
alter table signals
  add column if not exists candle_close_at timestamptz,
  add column if not exists timeframe        text default '1h';
create unique index if not exists signals_unique_candle_idx
  on signals (symbol, type, candle_close_at, timeframe)
  where candle_close_at is not null;

-- ─────────────────────────────────────────────────────────────
-- 2.3 Migración de datos existentes
-- ─────────────────────────────────────────────────────────────

-- Crear el usuario system para mantener compatibilidad
insert into app_users (id, email, display_name, role)
values ('00000000-0000-0000-0000-000000000001', 'system@tradingia.local', 'System', 'system')
on conflict (id) do nothing;

-- Migrar la config singleton al user_bot_config del system user
-- Se excluye SOLUSDT del array de símbolos (decisión del spec)
insert into user_bot_config (user_id, is_running, symbols, leverage, risk_per_trade, max_positions, max_daily_loss, margin_type)
select
  '00000000-0000-0000-0000-000000000001'::uuid,
  is_running,
  array(select unnest(symbols) except select 'SOLUSDT'),
  leverage,
  risk_per_trade,
  max_positions,
  max_daily_loss,
  'ISOLATED'  -- forzado
from bot_config where id = 1
on conflict (user_id) do nothing;

-- Asignar todos los registros existentes al system user
update trades set user_id = '00000000-0000-0000-0000-000000000001' where user_id is null;
update bot_logs set user_id = '00000000-0000-0000-0000-000000000001' where user_id is null;

-- Después de migrar, marcar user_id como not null en trades
alter table trades alter column user_id set not null;

-- Después de migrar, marcar is_shadow=false en trades existentes
update trades set is_shadow = false where is_shadow is null;

-- ─────────────────────────────────────────────────────────────
-- 2.4 Deprecación de tabla bot_config
-- bot_config NO se elimina aquí. Se elimina en fase 3 cuando
-- todo el código lea de user_bot_config en su lugar.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- 2.5 Shadow mode (Addendum 01a)
-- ─────────────────────────────────────────────────────────────

alter table trades
  add column if not exists is_shadow boolean not null default false;

create index if not exists trades_shadow_idx on trades (is_shadow);
create index if not exists trades_user_shadow_status_idx on trades (user_id, is_shadow, status);
