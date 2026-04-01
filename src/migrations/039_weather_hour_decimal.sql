-- Allow any time for weather alert scheduling (e.g. "17:34")
ALTER TABLE global_settings
  ALTER COLUMN daily_weather_hour TYPE VARCHAR(5)
  USING LPAD(daily_weather_hour::text, 2, '0') || ':00';
