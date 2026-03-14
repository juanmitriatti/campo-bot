ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS province TEXT;

CREATE TABLE IF NOT EXISTS ai_fallback_logs (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  input_text TEXT NOT NULL,
  claude_response TEXT,
  tokens_used INT,
  cost_usd NUMERIC,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_fallback_logs_created_at ON ai_fallback_logs(created_at);
