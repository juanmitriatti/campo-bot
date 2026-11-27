-- Última red en la base para lo que no puede existir. Complementa la 137.
-- NOT VALID: se exige en toda fila nueva o actualizada, sin revisar lo guardado
-- (en producción no había ninguna fila fuera de rango al escribirla, 27 nov 2026).
-- Topes holgados a propósito (monto: el del dashboard; camión: un total dictado
-- como una carga no puede tirar abajo la cosecha).
-- Montos en 0 son válidos (venta "a fijar"); un ajuste de hacienda puede ser 0.

-- Una inserción sin moneda es en pesos (así se leía en todos lados).
ALTER TABLE expenses ALTER COLUMN currency SET DEFAULT 'ARS';
ALTER TABLE incomes ALTER COLUMN currency SET DEFAULT 'ARS';

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('expenses', 'chk_expenses_currency', 'currency IS NOT NULL AND currency IN (''ARS'', ''USD'')'),
    ('expenses', 'chk_expenses_amount', 'amount IS NOT NULL AND amount >= 0 AND amount <= 1000000000000'),
    ('expenses', 'chk_expenses_date', 'expense_date IS NOT NULL'),
    ('incomes', 'chk_incomes_currency', 'currency IS NOT NULL AND currency IN (''ARS'', ''USD'')'),
    ('incomes', 'chk_incomes_amount', 'amount IS NOT NULL AND amount >= 0 AND amount <= 1000000000000'),
    ('incomes', 'chk_incomes_date', 'income_date IS NOT NULL'),
    ('plots', 'chk_plots_area_max', 'area_hectares IS NULL OR area_hectares <= 100000'),
    ('plot_crops', 'chk_plot_crops_ha_max', '(sowed_hectares IS NULL OR sowed_hectares <= 100000) AND (harvested_hectares IS NULL OR harvested_hectares <= 100000)'),
    ('plot_crops', 'chk_plot_crops_yield', '(yield_kg IS NULL OR (yield_kg >= 0 AND yield_kg <= 1000000000)) AND (declared_yield_kg IS NULL OR declared_yield_kg >= 0)'),
    ('harvest_loads', 'chk_harvest_loads_weight_max', 'weight_kg IS NULL OR weight_kg <= 1000000'),
    ('domain_events', 'chk_domain_events_quantity', 'quantity IS NULL OR quantity >= 0'),
    ('livestock_movements', 'chk_livestock_movements_count', 'count >= 0 AND count <= 100000'),
    ('livestock_groups', 'chk_livestock_groups_count_max', 'count <= 1000000')
  ) AS t(tbl, name, expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.tbl, c.name, c.expr);
    END IF;
  END LOOP;
END $$;
