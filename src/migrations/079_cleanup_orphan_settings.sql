-- Migration 079: Drop orphan keys from system_settings.
--
-- These rows were seeded by migration 026_dashboard_config.sql but never
-- registered in SETTING_DEFINITIONS (src/services/settings.service.js) and are
-- not read anywhere in the application code. They cannot be edited via the
-- admin UI (which only renders defined keys), so they're dead weight.
--
-- If any of these keys gets a real consumer in the future, re-add it to
-- SETTING_DEFINITIONS and seed via a new migration.

DELETE FROM system_settings
WHERE key IN (
  'AUDIO_COST_PER_MINUTE_USD',
  'CONFIDENCE_HIGH_SKIP_AI',
  'DEDUP_MAX_SIZE',
  'DEFAULT_FIELD_NAME',
  'DEFAULT_USER_PLAN',
  'FEATURE_GATE_CACHE_TTL_MS',
  'PENDING_TRANSACTION_TIMEOUT_MS',
  'SCHEDULER_CRON_EXPRESSION',
  'USER_CONTEXT_CACHE_TTL_MS'
);
