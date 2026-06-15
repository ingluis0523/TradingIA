-- ============================================================
-- Migración 003: Strategy ATR params en user_bot_config
-- Fase 1.5 — Sección 5 del spec 01b_PHASE_1.5_STRATEGY_FIX.md
--
-- Añade los multiplicadores SL/TP como columnas configurables
-- para poder iterar parámetros sin redeploy.
-- Defaults: SL 2.2, TP1 2.0, TP2 3.5 (ver spec sección 5).
-- ============================================================

alter table user_bot_config
  add column if not exists sl_atr_mult  numeric(4,2) not null default 2.2,
  add column if not exists tp1_atr_mult numeric(4,2) not null default 2.0,
  add column if not exists tp2_atr_mult numeric(4,2) not null default 3.5;

-- Verificación
select user_id, sl_atr_mult, tp1_atr_mult, tp2_atr_mult
from user_bot_config
where user_id = '00000000-0000-0000-0000-000000000001';
