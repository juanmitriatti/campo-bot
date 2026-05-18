-- Track the user's last livestock-inventory query for multi-turn inheritance.
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS last_livestock_query JSONB;
