-- Per-user catalog of expense / income categories. Learned over time via
-- usage_count + last_used_at. The agent suggests from the top 8.
CREATE TABLE IF NOT EXISTS user_categories (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('expense', 'income')),
  name VARCHAR(60) NOT NULL,
  usage_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Case-insensitive uniqueness scoped to (user, kind). The WHERE clause lets
-- a soft-deleted name be re-created later.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_categories_active
  ON user_categories (user_id, kind, lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_categories_top
  ON user_categories (user_id, kind, usage_count DESC, last_used_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE user_categories IS 'Per-user catalog. Backfilled from expenses/incomes once in migration 091.';
