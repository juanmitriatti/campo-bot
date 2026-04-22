-- Link livestock movements to auto-created expenses/incomes for traceability.
-- Populated when unit_price_ars or unit_price_usd is provided on entrada (→ expense) or salida (→ income).
ALTER TABLE livestock_movements ADD COLUMN IF NOT EXISTS linked_expense_id INT REFERENCES expenses(id) ON DELETE SET NULL;
ALTER TABLE livestock_movements ADD COLUMN IF NOT EXISTS linked_income_id INT REFERENCES incomes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_livestock_movements_expense ON livestock_movements(linked_expense_id) WHERE linked_expense_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_livestock_movements_income ON livestock_movements(linked_income_id) WHERE linked_income_id IS NOT NULL;
