-- Migration: add incomes table and name column to users

ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(100);

CREATE TABLE IF NOT EXISTS incomes (
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
  income_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP DEFAULT NULL
);
