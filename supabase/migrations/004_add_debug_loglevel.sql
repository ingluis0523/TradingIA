-- Allow DEBUG level in bot_logs for signal trace diagnostics.
-- Cleanup cron: DEBUG logs are purged every hour after 48h (see below).
alter table bot_logs drop constraint if exists bot_logs_level_check;
alter table bot_logs add constraint bot_logs_level_check
  check (level in ('DEBUG','INFO','WARN','ERROR','SUCCESS','TRADE'));

-- Purge DEBUG logs aggressively to avoid table bloat (150 logs/h per user).
-- Run this once in the Supabase SQL editor (requires pg_cron enabled):
--
-- select cron.schedule(
--   'cleanup-debug-logs',
--   '0 * * * *',
--   $$ delete from bot_logs where level = 'DEBUG' and created_at < now() - interval '48 hours' $$
-- );
