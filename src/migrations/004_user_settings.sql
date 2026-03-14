-- Migration: add user_settings and ai_usage tables

CREATE TABLE IF NOT EXISTS user_settings (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) UNIQUE,
  weekly_summary BOOLEAN DEFAULT true,
  weekly_summary_day INT DEFAULT 0,
  weekly_summary_hour INT DEFAULT 19,
  budget_alerts BOOLEAN DEFAULT true,
  rain_alerts BOOLEAN DEFAULT true,
  confirm_before_save BOOLEAN DEFAULT true,
  claude_daily_limit INT DEFAULT 50
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  input_tokens INT,
  output_tokens INT,
  total_tokens INT,
  created_at TIMESTAMP DEFAULT NOW()
);
