-- AI Intent Extraction settings
INSERT INTO system_settings (key, value) VALUES
  ('AI_INTENT_ENABLED', 'true'),
  ('AI_INTENT_MODEL', 'claude-haiku-4-5-20251001'),
  ('AI_INTENT_MAX_TOKENS', '300'),
  ('AI_INTENT_TIMEOUT_MS', '5000'),
  ('AI_INTENT_MIN_CONFIDENCE', '0.70')
ON CONFLICT (key) DO NOTHING;
