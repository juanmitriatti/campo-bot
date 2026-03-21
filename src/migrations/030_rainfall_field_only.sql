-- Migration 030: Rainfall field-level only
-- Removes plot_id usage from rainfall, adds dedup, fixes reporting

-- Backfill field_id from plot_id where missing
UPDATE rainfall r SET field_id = p.field_id
FROM plots p WHERE r.plot_id = p.id AND r.field_id IS NULL AND r.plot_id IS NOT NULL;

-- NULL out all plot_id (field-level only)
UPDATE rainfall SET plot_id = NULL WHERE plot_id IS NOT NULL;

-- Dedup existing data: keep newest per (user_id, field_id, date)
DELETE FROM rainfall WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, COALESCE(field_id, 0), rainfall_date) id
  FROM rainfall ORDER BY user_id, COALESCE(field_id, 0), rainfall_date, created_at DESC
);

-- Unique index for dedup enforcement
CREATE UNIQUE INDEX IF NOT EXISTS idx_rainfall_user_field_date
  ON rainfall (user_id, COALESCE(field_id, 0), rainfall_date);

-- Drop unused plot_id index
DROP INDEX IF EXISTS idx_rainfall_plot_id;

-- Remove dead setting
DELETE FROM system_settings WHERE key = 'WEATHER_FORECAST_DAYS';
