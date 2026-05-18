-- Track the user's last activity query for multi-turn inheritance.
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS last_activity_query JSONB;
