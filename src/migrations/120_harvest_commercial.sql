-- Cosecha como proceso comercial (Sep 2026).
--
-- 1. Cosecha de varios días: harvested_at pasa a ser el PRIMER día y
--    harvest_ended_at el último (antes había una sola fecha que se pisaba cada
--    día, y con ella el rinde declarado — bug P0).
-- 2. Avance de cosecha en hectáreas (harvested_hectares, acumulable) y rinde
--    esperado para comparar (expected_yield_kg_per_ha).
-- 3. Peso neto comercial por camión: la merma por humedad se calcula al
--    guardar (grain-merma.ts) y todas las lecturas de rinde usan
--    COALESCE(net_weight_kg, weight_kg).
-- 4. Documentación por camión: carta de porte, CTG, bruto/tara de balanza y
--    peso recibido en destino (para conciliar contra el romaneo).
-- 5. Venta de grano vinculada: comprador/acopio y estado del precio en el
--    ingreso, con la cantidad normalizada a kg para el saldo por acopio.

ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS harvest_ended_at DATE;
ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS harvested_hectares NUMERIC;
ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS expected_yield_kg_per_ha NUMERIC;

-- Backfill: primer y último día de cosecha desde los eventos existentes.
UPDATE plot_crops pc
   SET harvested_at = LEAST(pc.harvested_at, s.first_day),
       harvest_ended_at = COALESCE(pc.harvest_ended_at, s.last_day)
  FROM (
    SELECT plot_crop_id, MIN(event_date) AS first_day, MAX(event_date) AS last_day
      FROM domain_events
     WHERE event_type = 'harvest' AND deleted_at IS NULL AND plot_crop_id IS NOT NULL
     GROUP BY plot_crop_id
  ) s
 WHERE s.plot_crop_id = pc.id AND pc.harvested_at IS NOT NULL;

ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS net_weight_kg NUMERIC;
ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS merma_pct NUMERIC(5,2);
ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS gross_weight_kg NUMERIC;
ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS tare_kg NUMERIC;
ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS acopio_weight_kg NUMERIC;
ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS carta_porte VARCHAR(40);
ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS ctg VARCHAR(20);
ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

COMMENT ON COLUMN harvest_loads.weight_kg IS 'Kg que informó el usuario (bruto comercial, antes de merma).';
COMMENT ON COLUMN harvest_loads.net_weight_kg IS 'Kg netos después de la merma por humedad (grain-merma.ts). NULL = igual al bruto.';
COMMENT ON COLUMN harvest_loads.acopio_weight_kg IS 'Kg que pesó el destino (romaneo). Se compara contra weight_kg en "Para revisar".';

CREATE INDEX IF NOT EXISTS idx_harvest_loads_destinatario_lower
  ON harvest_loads (LOWER(destinatario)) WHERE destinatario IS NOT NULL;

ALTER TABLE incomes ADD COLUMN IF NOT EXISTS buyer VARCHAR(100);
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS price_status VARCHAR(10);
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS quantity_kg NUMERIC;

-- Backfill de la cantidad en kg para las ventas de grano ya cargadas.
UPDATE incomes
   SET quantity_kg = CASE
         WHEN LOWER(unit) IN ('tn','t','ton','tons','tonelada','toneladas') THEN quantity * 1000
         WHEN LOWER(unit) IN ('qq','quintal','quintales') THEN quantity * 100
         WHEN LOWER(unit) IN ('kg','kgs','kilo','kilos') THEN quantity
         ELSE NULL END
 WHERE quantity IS NOT NULL AND unit IS NOT NULL AND quantity_kg IS NULL;
