-- Add updated_at column to expenses, incomes, and domain_events tables
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NULL;
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NULL;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NULL;
