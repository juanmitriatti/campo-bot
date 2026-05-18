-- Persist the user's last financial_report filters so the agent can refine
-- the query in follow-up turns ("y sin sueldos", "ordenalos por monto",
-- "ahora solo los de mayo") without restating everything.

ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS last_finance_query JSONB;
