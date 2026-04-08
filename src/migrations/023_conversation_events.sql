-- Migration 023: Conversation events for observability
-- Event types: message_received, intent_detected, flow_started, flow_step,
--              flow_completed, flow_abandoned, fallback_ai, error, menu_opened, command_executed

CREATE TABLE IF NOT EXISTS conversation_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_type VARCHAR(30) NOT NULL,
  flow_state VARCHAR(50),
  flow_step INTEGER,
  intent_type VARCHAR(30),
  intent_command VARCHAR(50),
  confidence NUMERIC,
  source VARCHAR(20),
  metadata JSONB DEFAULT '{}',
  session_id VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ce_user ON conversation_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ce_type ON conversation_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ce_flow ON conversation_events(flow_state, event_type) WHERE flow_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ce_session ON conversation_events(session_id, created_at) WHERE session_id IS NOT NULL;
