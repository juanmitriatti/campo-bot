-- 127: el rinde DECLARADO vive aparte del que suman los camiones, y cada día de
-- cosecha guarda lo que aportó.
--
-- Hasta acá `plot_crops.yield_kg` era a la vez lo que dijo el usuario y el piso
-- de `updateYieldFromLoads` (GREATEST con el valor viejo). Consecuencias
-- (auditoría oct 2026):
--   AGR-2 / DSH-2: corregir o borrar un camión nunca bajaba el rinde — el valor
--                  inflado quedaba como piso para siempre.
--   AGR-3:         borrar la cosecha de UN día ponía en NULL el rinde y las
--                  fechas de toda la campaña.
--   AGR-9:         "no, fueron 260 tn" sobre la cosecha de un día pisaba el
--                  rinde de toda la campaña de varios días.
--
-- Ahora:
--   plot_crops.declared_yield_kg   = lo declarado (se recalcula desde los días).
--   plot_crops.yield_kg            = GREATEST(declarado, Σ camiones netos).
--   domain_events.harvest_yield_kg / harvest_yield_mode = lo que aportó ESE día:
--     'total'   → "rindió 42 qq/ha" sin hectáreas: es el total de la campaña.
--     'partial' → "cosechamos 40 ha, rindió 42 qq/ha": se suma.
--   El declarado se arma recorriendo los días en orden: total fija, parcial suma
--   (exactamente lo que hacía el handler en el momento), así borrar o corregir
--   un día recalcula sin perder los demás.
--   domain_events.harvest_hectares = las ha cosechadas ese día (avance).
-- Idempotente.

ALTER TABLE plot_crops    ADD COLUMN IF NOT EXISTS declared_yield_kg NUMERIC;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS harvest_yield_kg NUMERIC;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS harvest_yield_mode VARCHAR(10);
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS harvest_hectares NUMERIC;

DO $$ BEGIN
  ALTER TABLE domain_events ADD CONSTRAINT domain_events_harvest_yield_mode_chk
    CHECK (harvest_yield_mode IS NULL OR harvest_yield_mode IN ('total', 'partial'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Declarado de las campañas existentes: el yield_kg, salvo cuando es justo la
-- suma de los camiones (ahí lo pusieron los camiones, no el usuario).
UPDATE plot_crops pc
   SET declared_yield_kg = pc.yield_kg
 WHERE pc.yield_kg IS NOT NULL
   AND pc.declared_yield_kg IS NULL
   AND pc.yield_kg > COALESCE((
         SELECT SUM(COALESCE(hl.net_weight_kg, hl.weight_kg))
           FROM harvest_loads hl
           JOIN domain_events de ON de.id = hl.domain_event_id AND de.deleted_at IS NULL
          WHERE hl.plot_crop_id = pc.id), 0);

-- Sin historia por día: el declarado se le atribuye entero al ÚLTIMO día de
-- cosecha como total, que es lo que reproduce el valor actual.
UPDATE domain_events d
   SET harvest_yield_kg = pc.declared_yield_kg,
       harvest_yield_mode = 'total'
  FROM plot_crops pc
 WHERE d.plot_crop_id = pc.id
   AND pc.declared_yield_kg IS NOT NULL
   AND d.harvest_yield_mode IS NULL
   AND d.id = (SELECT MAX(x.id) FROM domain_events x
                WHERE x.plot_crop_id = pc.id AND x.event_type = 'harvest'
                  AND x.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM domain_events y
                    WHERE y.plot_crop_id = pc.id AND y.harvest_yield_mode IS NOT NULL);
