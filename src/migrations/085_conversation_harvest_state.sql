-- Track the user's last harvest-loads query for multi-turn inheritance.
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS last_harvest_query JSONB;
