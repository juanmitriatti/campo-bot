-- Add rain alert threshold to user_settings
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS rain_alert_mm INT DEFAULT 10;

-- Global settings table (single row)
CREATE TABLE IF NOT EXISTS global_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  daily_weather_enabled BOOLEAN DEFAULT true,
  daily_weather_hour INT DEFAULT 6,
  default_rain_alert_mm INT DEFAULT 10,
  budget_alert_80 BOOLEAN DEFAULT true,
  budget_alert_100 BOOLEAN DEFAULT true,
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO global_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
