-- Unit price for insumo expenses (parity with incomes.unit_price)
-- Enables "compré 50 bolsas de urea a 8000 c/u" → quantity=50, unit_price=8000, amount=400000
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS unit_price NUMERIC;
