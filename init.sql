CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  phone_number VARCHAR(20) UNIQUE,
  name VARCHAR(100),
  city VARCHAR(100),
  province VARCHAR(100),
  last_name VARCHAR(100),
  email TEXT,
  password_hash TEXT,
  role VARCHAR(20) NOT NULL DEFAULT 'end_user'
);

CREATE TABLE fields (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  name VARCHAR(100) NOT NULL,
  city VARCHAR(100),
  province VARCHAR(100),
  deleted_at TIMESTAMP DEFAULT NULL,
  deleted_by VARCHAR(50) DEFAULT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE plots (
  id SERIAL PRIMARY KEY,
  field_id INT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  area_hectares NUMERIC,
  soil_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP DEFAULT NULL,
  deleted_by VARCHAR(50) DEFAULT NULL,
  UNIQUE(field_id, name)
);

CREATE TABLE expenses (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  category VARCHAR(50),
  description TEXT,
  amount NUMERIC,
  currency VARCHAR(10),
  field_id INT REFERENCES fields(id),
  plot_id INT REFERENCES plots(id),
  expense_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP DEFAULT NULL
);

CREATE TABLE incomes (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  category VARCHAR(50),
  description TEXT,
  amount NUMERIC,
  currency VARCHAR(10),
  quantity NUMERIC,
  unit VARCHAR(20),
  unit_price NUMERIC,
  field_id INT REFERENCES fields(id),
  plot_id INT REFERENCES plots(id),
  income_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP DEFAULT NULL
);

CREATE TABLE budgets (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  category VARCHAR(50) NOT NULL,
  monthly_limit NUMERIC NOT NULL,
  UNIQUE(user_id, category)
);

CREATE TABLE rainfall (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  field_id INT REFERENCES fields(id),
  plot_id INT REFERENCES plots(id),
  millimeters NUMERIC NOT NULL,
  rainfall_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE user_settings (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) UNIQUE,
  weekly_summary BOOLEAN DEFAULT true,
  weekly_summary_day INT DEFAULT 0,
  weekly_summary_hour INT DEFAULT 19,
  budget_alerts BOOLEAN DEFAULT true,
  rain_alerts BOOLEAN DEFAULT true,
  confirm_before_save BOOLEAN DEFAULT true,
  claude_daily_limit INT DEFAULT 50,
  rain_alert_mm INT DEFAULT 10,
  max_fields INT DEFAULT 10
);

CREATE TABLE global_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  daily_weather_enabled BOOLEAN DEFAULT true,
  daily_weather_hour INT DEFAULT 6,
  default_rain_alert_mm INT DEFAULT 10,
  budget_alert_80 BOOLEAN DEFAULT true,
  budget_alert_100 BOOLEAN DEFAULT true,
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO global_settings (id) VALUES (1);

CREATE TABLE ai_usage (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  input_tokens INT,
  output_tokens INT,
  total_tokens INT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE unparsed_messages (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE ai_fallback_logs (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  input_text TEXT NOT NULL,
  claude_response TEXT,
  tokens_used INT,
  cost_usd NUMERIC,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_fallback_logs_created_at ON ai_fallback_logs(created_at);

CREATE TABLE plot_aliases (
  id SERIAL PRIMARY KEY,
  plot_id INT NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  alias VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE conversation_state (
  user_id INT PRIMARY KEY REFERENCES users(id),
  last_plot_id INT REFERENCES plots(id) ON DELETE SET NULL,
  last_field_id INT REFERENCES fields(id) ON DELETE SET NULL,
  updated_at TIMESTAMP DEFAULT NOW(),
  flow_state VARCHAR(50) DEFAULT 'idle',
  flow_step INT DEFAULT 0,
  flow_data JSONB DEFAULT '{}',
  flow_started_at TIMESTAMP DEFAULT NULL,
  flow_expires_at TIMESTAMP DEFAULT NULL,
  last_intent TEXT,
  last_activity_type TEXT,
  last_query_type TEXT,
  last_time_reference TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_expires
  ON conversation_state(flow_expires_at) WHERE flow_state != 'idle';

CREATE TABLE IF NOT EXISTS plot_crops (
  id SERIAL PRIMARY KEY,
  plot_id INT NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  crop VARCHAR(50) NOT NULL,
  season_year INT NOT NULL,
  season_type VARCHAR(10) NOT NULL DEFAULT 'gruesa',
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plots_field_id ON plots(field_id);
CREATE INDEX IF NOT EXISTS idx_expenses_plot_id ON expenses(plot_id);
CREATE INDEX IF NOT EXISTS idx_incomes_plot_id ON incomes(plot_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rainfall_user_field_date ON rainfall (user_id, COALESCE(field_id, 0), rainfall_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plot_aliases_unique ON plot_aliases (plot_id, alias);
CREATE INDEX IF NOT EXISTS idx_plot_aliases_alias ON plot_aliases (alias);
CREATE INDEX IF NOT EXISTS idx_plot_crops_plot_id ON plot_crops(plot_id);
CREATE INDEX IF NOT EXISTS idx_plot_crops_active ON plot_crops(plot_id, end_date) WHERE end_date IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plot_crops_unique_active ON plot_crops(plot_id) WHERE end_date IS NULL;

CREATE TABLE IF NOT EXISTS domain_events (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  plot_id INT REFERENCES plots(id),
  plot_crop_id INT REFERENCES plot_crops(id),
  event_type VARCHAR(30) NOT NULL,
  event_date DATE NOT NULL DEFAULT CURRENT_DATE,
  crop VARCHAR(50),
  product VARCHAR(100),
  product_type VARCHAR(30),
  quantity NUMERIC,
  unit VARCHAR(20),
  implement VARCHAR(50),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_events_user_id ON domain_events(user_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_plot_id ON domain_events(plot_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_plot_crop_id ON domain_events(plot_crop_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_event_type ON domain_events(event_type);
CREATE INDEX IF NOT EXISTS idx_domain_events_event_date ON domain_events(event_date);

-- Learning tables (011)
CREATE TABLE IF NOT EXISTS farmer_vocabulary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INT NOT NULL REFERENCES users(id),
  phrase VARCHAR(200) NOT NULL,
  normalized_phrase VARCHAR(200) NOT NULL,
  resolved_value VARCHAR(200) NOT NULL,
  category VARCHAR(30) NOT NULL,
  confidence NUMERIC NOT NULL DEFAULT 0.5,
  hit_count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, normalized_phrase, category)
);

CREATE TABLE IF NOT EXISTS message_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  normalized_message TEXT NOT NULL,
  intent VARCHAR(30) NOT NULL,
  entities JSONB DEFAULT '{}',
  source VARCHAR(20) NOT NULL DEFAULT 'parser',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farmer_vocabulary_user ON farmer_vocabulary(user_id);
CREATE INDEX IF NOT EXISTS idx_farmer_vocabulary_category ON farmer_vocabulary(user_id, category);
CREATE INDEX IF NOT EXISTS idx_message_patterns_user ON message_patterns(user_id);

-- Plans and feature gating (012)
CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  price_ars NUMERIC DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS features (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plan_features (
  plan_id INT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_id INT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, feature_id)
);

CREATE INDEX IF NOT EXISTS idx_users_plan_id ON users(plan_id);

-- Seed default plans
INSERT INTO plans (name, display_name, price_ars) VALUES
  ('free', 'Gratis', 0),
  ('pro', 'Pro', 5000),
  ('pro_plus', 'Pro+', 12000),
  ('enterprise', 'Enterprise', 0)
ON CONFLICT (name) DO NOTHING;

-- Seed features
INSERT INTO features (key, description) VALUES
  ('expenses', 'Registro de gastos'),
  ('incomes', 'Registro de ingresos'),
  ('fields', 'Gestión de campos y lotes'),
  ('budgets', 'Presupuestos mensuales'),
  ('rainfall', 'Registro de lluvias'),
  ('agronomy', 'Actividades agronómicas'),
  ('csv_export', 'Exportar datos a CSV'),
  ('weather', 'Consulta de clima'),
  ('audio', 'Procesamiento de mensajes de voz'),
  ('sharing', 'Campos compartidos')
ON CONFLICT (key) DO NOTHING;

-- FREE plan features
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.name = 'free' AND f.key IN ('expenses', 'incomes', 'fields')
ON CONFLICT DO NOTHING;

-- PRO plan features
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.name = 'pro' AND f.key IN ('expenses', 'incomes', 'fields', 'budgets', 'rainfall', 'weather', 'csv_export')
ON CONFLICT DO NOTHING;

-- PRO+ plan features
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.name = 'pro_plus' AND f.key IN ('expenses', 'incomes', 'fields', 'budgets', 'rainfall', 'weather', 'csv_export', 'agronomy', 'audio')
ON CONFLICT DO NOTHING;

-- ENTERPRISE plan features (all)
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.name = 'enterprise'
ON CONFLICT DO NOTHING;

-- Add plan_id to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_id INT REFERENCES plans(id);

-- Set existing users to free plan
UPDATE users SET plan_id = (SELECT id FROM plans WHERE name = 'free')
WHERE plan_id IS NULL;

-- Audio transcription logs (015)
CREATE TABLE IF NOT EXISTS audio_transcription_logs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  audio_duration_seconds NUMERIC,
  provider VARCHAR(50),
  model VARCHAR(50),
  tokens_used INT,
  cost_usd NUMERIC,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audio_transcription_logs_user_id ON audio_transcription_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audio_transcription_logs_created_at ON audio_transcription_logs(created_at);

-- Agro observations & reports (016)
CREATE TABLE IF NOT EXISTS agro_observations (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  field_id INT REFERENCES fields(id),
  plot_id INT REFERENCES plots(id),
  observation_text TEXT NOT NULL,
  normalized_text TEXT,
  category VARCHAR(30) NOT NULL DEFAULT 'general',
  source VARCHAR(10) NOT NULL DEFAULT 'text',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agro_obs_field_created ON agro_observations(field_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agro_obs_plot ON agro_observations(plot_id);
CREATE INDEX IF NOT EXISTS idx_agro_obs_dedup ON agro_observations(user_id, COALESCE(plot_id, 0), normalized_text, created_at DESC);

CREATE TABLE IF NOT EXISTS agronomic_reports (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  field_id INT NOT NULL REFERENCES fields(id),
  week_number INT NOT NULL,
  year INT NOT NULL,
  pdf_path TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agro_reports_field ON agronomic_reports(field_id);
CREATE INDEX IF NOT EXISTS idx_agro_reports_week ON agronomic_reports(field_id, week_number, year);

-- System settings key-value store (017)
CREATE TABLE IF NOT EXISTS system_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_key ON system_settings(key);

-- Error logs (018)
CREATE TABLE IF NOT EXISTS error_logs (
  id SERIAL PRIMARY KEY,
  service VARCHAR(50) NOT NULL,
  error_type VARCHAR(100) NOT NULL,
  message TEXT NOT NULL,
  user_id INT NULL,
  phone VARCHAR(30) NULL,
  request_context TEXT NULL,
  severity VARCHAR(20) DEFAULT 'error',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_service ON error_logs(service);
CREATE INDEX IF NOT EXISTS idx_error_created ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_user ON error_logs(user_id);

-- Conversation logs (019)
CREATE TABLE IF NOT EXISTS conversation_logs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  phone VARCHAR(30) NOT NULL,
  direction VARCHAR(10) NOT NULL DEFAULT 'inbound',
  message_text TEXT,
  intent_type VARCHAR(30),
  intent_command VARCHAR(50),
  flow_state VARCHAR(50),
  flow_step INT,
  ai_used BOOLEAN DEFAULT false,
  response_text TEXT,
  response_interactive BOOLEAN DEFAULT false,
  processing_time_ms INT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_logs_user ON conversation_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_logs_created ON conversation_logs(created_at DESC);

-- Parser error tracking (020)
CREATE TABLE IF NOT EXISTS parser_errors (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  message TEXT NOT NULL,
  normalized_message TEXT,
  parser_output JSONB,
  error_reason VARCHAR(50),
  confidence NUMERIC,
  resolved_intent VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parser_errors_reason ON parser_errors(error_reason, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parser_errors_user ON parser_errors(user_id, created_at DESC);

-- Deletion history log (021)
CREATE TABLE IF NOT EXISTS deletion_log (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  entity_type VARCHAR(20) NOT NULL,
  entity_id INT NOT NULL,
  entity_name VARCHAR(100),
  parent_name VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  deleted_at TIMESTAMP DEFAULT NOW(),
  restored_at TIMESTAMP DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_deletion_log_user ON deletion_log(user_id, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_deletion_log_type ON deletion_log(entity_type, deleted_at DESC);

-- Unique email (partial — allows NULL for WhatsApp-only users)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users (email) WHERE email IS NOT NULL;

-- Refresh tokens (multi-device, rotation)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Observation edit history
ALTER TABLE agro_observations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS observation_history (
  id SERIAL PRIMARY KEY,
  observation_id INT NOT NULL REFERENCES agro_observations(id) ON DELETE CASCADE,
  previous_text TEXT NOT NULL,
  new_text TEXT NOT NULL,
  previous_category VARCHAR(30),
  new_category VARCHAR(30),
  edited_by INT NOT NULL REFERENCES users(id),
  edited_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_obs_history_obs ON observation_history(observation_id, edited_at DESC);
