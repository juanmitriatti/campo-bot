-- Tipo de gasto: 'varios' (servicios/labranzas) vs 'insumo' (productos almacenables)
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS expense_type VARCHAR(20) DEFAULT 'varios';

-- Campos de producto para gastos de insumo
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS product VARCHAR(150);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS quantity NUMERIC;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS unit VARCHAR(30);

-- Index para filtrar por tipo
CREATE INDEX IF NOT EXISTS idx_expenses_type ON expenses(expense_type);

-- Backfill: categorías de insumo existentes → tipo 'insumo'
UPDATE expenses SET expense_type = 'insumo'
WHERE category IN ('fertilizantes', 'semillas', 'agroquimicos', 'combustible')
  AND expense_type = 'varios';
