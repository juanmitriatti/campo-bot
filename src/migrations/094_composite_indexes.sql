-- Audit fix: composite indexes for the most common dashboard queries.
--   - expenses / incomes: WHERE user_id AND deleted_at IS NULL ORDER BY date DESC
--   - domain_events:      same pattern, hot on the activity feed
--
-- All indexes are partial (WHERE deleted_at IS NULL) so they stay slim and
-- don't grow with soft-deleted rows. CONCURRENTLY isn't possible inside
-- migrations (no tx control), but these tables are small enough that the
-- short ACCESS EXCLUSIVE lock during creation is fine.
-- IF NOT EXISTS makes the migration idempotent on prod.

CREATE INDEX IF NOT EXISTS idx_expenses_user_active_date
  ON expenses (user_id, expense_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_incomes_user_active_date
  ON incomes (user_id, income_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_domain_events_user_active_date
  ON domain_events (user_id, event_date DESC)
  WHERE deleted_at IS NULL;

-- Audit fix: incomes was missing the `income_type` companion to
-- expenses.expense_type (drift between the two parallel tables). Add it
-- with the same default and a complementary index. Existing rows pick up
-- the default automatically.
ALTER TABLE incomes
  ADD COLUMN IF NOT EXISTS income_type VARCHAR(20) DEFAULT 'varios';

CREATE INDEX IF NOT EXISTS idx_incomes_type ON incomes (income_type);

-- Optional product/quantity columns also missing on incomes — useful for
-- "vendí 20 tn soja a 200000 c/u" semantics that expenses already supports
-- via product/quantity/unit/unit_price.
ALTER TABLE incomes
  ADD COLUMN IF NOT EXISTS product VARCHAR(150);

