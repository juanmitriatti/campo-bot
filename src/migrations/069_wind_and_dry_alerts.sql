-- Weather alert enhancements: dry window + wind alerts
-- Dry window: notify when N consecutive days without rain are forecasted (good for fumigation/seeding)
-- Wind: notify when forecast wind exceeds threshold (bad for agrochemical application)

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dry_window_alerts BOOLEAN DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dry_window_days INT DEFAULT 3;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS wind_alerts BOOLEAN DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS wind_alert_kmh INT DEFAULT 20;

ALTER TABLE global_settings ADD COLUMN IF NOT EXISTS default_dry_window_days INT DEFAULT 3;
ALTER TABLE global_settings ADD COLUMN IF NOT EXISTS default_wind_alert_kmh INT DEFAULT 20;
