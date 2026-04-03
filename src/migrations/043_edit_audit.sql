-- Migration 043: Add edited_by column to expenses, incomes, domain_events
-- Tracks who last edited each record (for shared field audit trail)

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS edited_by INT REFERENCES users(id);
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS edited_by INT REFERENCES users(id);
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS edited_by INT REFERENCES users(id);
