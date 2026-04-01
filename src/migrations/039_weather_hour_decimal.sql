-- Allow half-hour weather alert scheduling (e.g. 17.5 = 17:30)
ALTER TABLE global_settings
  ALTER COLUMN daily_weather_hour TYPE NUMERIC(3,1)
  USING daily_weather_hour::NUMERIC(3,1);
