-- Migration: add rainfall tracking table

CREATE TABLE IF NOT EXISTS rainfall (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  field_id INT REFERENCES fields(id),
  millimeters NUMERIC NOT NULL,
  rainfall_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW()
);
