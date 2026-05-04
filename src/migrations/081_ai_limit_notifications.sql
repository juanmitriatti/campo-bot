-- Phase 1 — soft-block transparente.
-- Track when we last warned a user that they were near or at their daily AI
-- limit. Used by LimitNotifierService to dedup notifications to once per day.
--
-- Stored as DATE (not TIMESTAMPTZ) because the daily quota itself resets at
-- the server's calendar day boundary; we only need day-granularity to dedup.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS last_limit_warning_at DATE,
  ADD COLUMN IF NOT EXISTS last_limit_hit_at DATE;
