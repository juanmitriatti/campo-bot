-- Migration 026: Dashboard configuration, audit log, user status
-- Adds all parametrizable settings, admin audit trail, user management fields

-- ─── New system_settings ──────────────────────────────────────────────────────

INSERT INTO system_settings (key, value) VALUES
  -- Conversational fallback
  ('CONVERSATIONAL_FALLBACK_MODEL', 'claude-haiku-4-5-20251001'),
  ('CONVERSATIONAL_FALLBACK_MAX_TOKENS', '120'),
  ('CONVERSATIONAL_FALLBACK_TIMEOUT_MS', '5000'),
  ('CONVERSATIONAL_FALLBACK_TEMPERATURE', '0.3'),
  ('CONVERSATIONAL_FALLBACK_RATE_LIMIT_MAX', '5'),
  ('CONVERSATIONAL_FALLBACK_RATE_LIMIT_WINDOW_MS', '600000'),
  -- Confidence thresholds
  ('CONFIDENCE_HIGH_SKIP_AI', '0.75'),
  ('CONFIDENCE_LOW_CONFIRM', '0.70'),
  ('CONFIDENCE_UNKNOWN_FALLBACK', '0.50'),
  -- Flow & conversation
  ('FLOW_TIMEOUT_MS', '600000'),
  ('FLOW_MAX_STEP_FAILURES', '3'),
  ('PENDING_TRANSACTION_TIMEOUT_MS', '300000'),
  ('DEDUP_MAX_SIZE', '1000'),
  -- Audio
  ('MAX_AUDIO_PER_HOUR', '10'),
  ('AUDIO_COST_PER_MINUTE_USD', '0.006'),
  -- Cache
  ('USER_CONTEXT_CACHE_TTL_MS', '60000'),
  ('FEATURE_GATE_CACHE_TTL_MS', '300000'),
  -- Scheduler & weather
  ('SCHEDULER_CRON_EXPRESSION', '0 * * * *'),
  ('WEATHER_FORECAST_DAYS', '3'),
  ('DEFAULT_RAIN_ALERT_MM', '10'),
  -- Domain defaults
  ('DEFAULT_FIELD_NAME', 'General'),
  ('DEFAULT_USER_PLAN', 'free')
ON CONFLICT (key) DO NOTHING;

-- ─── Admin audit log ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          SERIAL PRIMARY KEY,
  admin_ip    VARCHAR(45),
  action      VARCHAR(50) NOT NULL,
  entity_type VARCHAR(30),
  entity_id   INTEGER,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON admin_audit_log(created_at);

-- ─── User management fields ──────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_last_message ON users(last_message_at);
