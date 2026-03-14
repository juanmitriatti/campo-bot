-- Conversation error logging for flow debugging
CREATE TABLE IF NOT EXISTS conversation_errors (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  flow_state TEXT,
  step INTEGER,
  error_type TEXT NOT NULL,
  error_message TEXT,
  user_input TEXT,
  flow_data JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversation_errors_user ON conversation_errors(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_errors_type ON conversation_errors(error_type);
CREATE INDEX IF NOT EXISTS idx_conversation_errors_created ON conversation_errors(created_at);
