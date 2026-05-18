-- Track the user's last stock query for multi-turn inheritance.
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS last_stock_query JSONB;
