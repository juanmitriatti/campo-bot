-- Add mini conversational memory fields to conversation_state
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS last_intent TEXT,
  ADD COLUMN IF NOT EXISTS last_activity_type TEXT,
  ADD COLUMN IF NOT EXISTS last_query_type TEXT,
  ADD COLUMN IF NOT EXISTS last_time_reference TEXT;
