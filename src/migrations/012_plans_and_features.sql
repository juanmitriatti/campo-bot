-- Plans and feature gating for SaaS subscription tiers

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

-- Add plan_id to users (default NULL = FREE plan until assigned)
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_id INT REFERENCES plans(id);

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
  ('agronomy', 'Actividades agronómicas (fumigación, fertilización, etc.)'),
  ('csv_export', 'Exportar datos a CSV'),
  ('weather', 'Consulta de clima'),
  ('ai_fallback', 'Parsing inteligente con IA')
ON CONFLICT (key) DO NOTHING;

-- Assign features to plans
-- FREE: expenses, incomes, fields
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.name = 'free' AND f.key IN ('expenses', 'incomes', 'fields')
ON CONFLICT DO NOTHING;

-- PRO: all of FREE + budgets, rainfall, weather, csv_export
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.name = 'pro' AND f.key IN ('expenses', 'incomes', 'fields', 'budgets', 'rainfall', 'weather', 'csv_export')
ON CONFLICT DO NOTHING;

-- PRO_PLUS: all of PRO + agronomy, ai_fallback
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.name = 'pro_plus' AND f.key IN ('expenses', 'incomes', 'fields', 'budgets', 'rainfall', 'weather', 'csv_export', 'agronomy', 'ai_fallback')
ON CONFLICT DO NOTHING;

-- ENTERPRISE: all features
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.name = 'enterprise'
ON CONFLICT DO NOTHING;

-- Set existing users to FREE plan by default
UPDATE users SET plan_id = (SELECT id FROM plans WHERE name = 'free')
WHERE plan_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_plan_id ON users(plan_id);
