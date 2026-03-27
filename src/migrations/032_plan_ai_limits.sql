-- Migration 032: Plan-based AI daily limits
-- Adds daily_ai_limit column to plans table and creates ai_limit_requests tracking table

ALTER TABLE plans ADD COLUMN IF NOT EXISTS daily_ai_limit INT DEFAULT 20;

-- Set per-plan defaults
UPDATE plans SET daily_ai_limit = 20 WHERE name = 'free';
UPDATE plans SET daily_ai_limit = 100 WHERE name = 'pro';
UPDATE plans SET daily_ai_limit = 300 WHERE name = 'pro_plus';
UPDATE plans SET daily_ai_limit = 1000 WHERE name = 'enterprise';

-- Track "request more messages" actions for analytics
CREATE TABLE IF NOT EXISTS ai_limit_requests (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  plan_name VARCHAR(50),
  daily_count INT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_limit_requests_user ON ai_limit_requests(user_id, created_at DESC);
