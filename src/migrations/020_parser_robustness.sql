-- 020: Parser robustness — structured error tracking
CREATE TABLE IF NOT EXISTS parser_errors (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  message TEXT NOT NULL,
  normalized_message TEXT,
  parser_output JSONB,
  error_reason VARCHAR(50),
  confidence NUMERIC,
  resolved_intent VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parser_errors_reason ON parser_errors(error_reason, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parser_errors_user ON parser_errors(user_id, created_at DESC);
