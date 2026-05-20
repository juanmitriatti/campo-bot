-- Add soft-delete column to domain_events so undo can work on health/repro/weighing
-- events without losing audit history. All read queries must filter
-- `deleted_at IS NULL` from now on.

ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_domain_events_user_active
  ON domain_events(user_id) WHERE deleted_at IS NULL;
