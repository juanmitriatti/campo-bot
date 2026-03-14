-- 019: Conversation engine - flow tracking + conversation logs

-- Extend conversation_state with flow tracking
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS flow_state VARCHAR(50) DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS flow_step INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flow_data JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS flow_started_at TIMESTAMP DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS flow_expires_at TIMESTAMP DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_state_expires
  ON conversation_state(flow_expires_at) WHERE flow_state != 'idle';

-- Conversation logs for analytics
CREATE TABLE IF NOT EXISTS conversation_logs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  phone VARCHAR(30) NOT NULL,
  direction VARCHAR(10) NOT NULL DEFAULT 'inbound',
  message_text TEXT,
  intent_type VARCHAR(30),
  intent_command VARCHAR(50),
  flow_state VARCHAR(50),
  flow_step INT,
  ai_used BOOLEAN DEFAULT false,
  response_text TEXT,
  response_interactive BOOLEAN DEFAULT false,
  processing_time_ms INT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_logs_user ON conversation_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_logs_created ON conversation_logs(created_at DESC);
