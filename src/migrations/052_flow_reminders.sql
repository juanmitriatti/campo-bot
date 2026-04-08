-- 052: Flow reminder tracking
-- Tracks when the half-life "¿Seguís ahí?" warning was sent for an active flow,
-- so the scheduler doesn't re-notify the same flow multiple times.

ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS flow_halflife_notified_at TIMESTAMP DEFAULT NULL;

-- Index to speed up scheduler scans for active flows needing a reminder
CREATE INDEX IF NOT EXISTS idx_conversation_state_flow_reminder
  ON conversation_state(flow_expires_at)
  WHERE flow_state != 'idle';
