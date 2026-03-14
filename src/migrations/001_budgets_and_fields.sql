-- Migration for existing databases
-- Adds budgets, fields tables and new columns to expenses

CREATE TABLE IF NOT EXISTS fields (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  name VARCHAR(100) NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  category VARCHAR(50) NOT NULL,
  monthly_limit NUMERIC NOT NULL,
  UNIQUE(user_id, category)
);

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS field_id INT REFERENCES fields(id);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL;
