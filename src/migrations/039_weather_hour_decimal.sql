-- Allow any time for weather alert scheduling (e.g. "17:34")
-- Idempotent: only converts if column is still INTEGER
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'global_settings'
      AND column_name = 'daily_weather_hour'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE global_settings
      ALTER COLUMN daily_weather_hour TYPE VARCHAR(5)
      USING LPAD(daily_weather_hour::text, 2, '0') || ':00';
  END IF;
END $$;
