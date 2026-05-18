-- Track the user's last scouting query so multi-turn follow-ups can inherit
-- the prior filters (mirror of last_finance_query from 083).
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS last_scouting_query JSONB;
