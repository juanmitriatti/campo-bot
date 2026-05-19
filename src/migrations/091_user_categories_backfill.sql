-- One-shot backfill: convert each user's free-text categories on expenses + incomes
-- into rows in user_categories. INITCAP normalizes casing; the ON CONFLICT keeps
-- the migration idempotent (safe to re-run after the initial deploy).

INSERT INTO user_categories (user_id, kind, name, usage_count, last_used_at, created_at)
SELECT
  e.user_id,
  'expense' AS kind,
  INITCAP(TRIM(e.category)) AS name,
  COUNT(*) AS usage_count,
  MAX(e.created_at) AS last_used_at,
  MIN(e.created_at) AS created_at
FROM expenses e
WHERE e.category IS NOT NULL
  AND TRIM(e.category) <> ''
  AND e.deleted_at IS NULL
GROUP BY e.user_id, INITCAP(TRIM(e.category))
ON CONFLICT DO NOTHING;

INSERT INTO user_categories (user_id, kind, name, usage_count, last_used_at, created_at)
SELECT
  i.user_id,
  'income' AS kind,
  INITCAP(TRIM(i.category)) AS name,
  COUNT(*) AS usage_count,
  MAX(i.created_at) AS last_used_at,
  MIN(i.created_at) AS created_at
FROM incomes i
WHERE i.category IS NOT NULL
  AND TRIM(i.category) <> ''
  AND i.deleted_at IS NULL
GROUP BY i.user_id, INITCAP(TRIM(i.category))
ON CONFLICT DO NOTHING;
