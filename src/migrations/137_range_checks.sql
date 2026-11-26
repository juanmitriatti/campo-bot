-- Rangos válidos en la base (auditoría de datos, nov 2026, #16). Las validaciones
-- viven en los handlers y las rutas, pero cualquier camino que no pase por ellos
-- (ajustes de silo, rutas directas, scripts) podía escribir superficies negativas,
-- camiones con peso negativo o lluvias de -50 mm. Estos CHECK son la última red.
--
-- NOT VALID: se exigen en toda fila NUEVA o actualizada, pero NO revisan lo que ya
-- está guardado (no hay que corregir datos viejos para desplegar). Cuando se
-- confirme que no queda nada fuera de rango:  ALTER TABLE <t> VALIDATE CONSTRAINT <c>;
--
-- Fuera de esta migración, a propósito: plot_crops.yield_kg y domain_events.quantity.
-- En la base ya hay una cosecha cargada con -500 kg (error de tipeo del usuario): un
-- CHECK sobre esas columnas haría fallar cualquier UPDATE de esa fila hasta que se
-- corrija a mano. El chat ahora rechaza rindes <= 0 (agronomy.handler).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plots_area_positive') THEN
    ALTER TABLE plots ADD CONSTRAINT chk_plots_area_positive
      CHECK (area_hectares IS NULL OR area_hectares > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plot_crops_sowed_positive') THEN
    ALTER TABLE plot_crops ADD CONSTRAINT chk_plot_crops_sowed_positive
      CHECK (sowed_hectares IS NULL OR sowed_hectares > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plot_crops_harvested_ha_nonneg') THEN
    ALTER TABLE plot_crops ADD CONSTRAINT chk_plot_crops_harvested_ha_nonneg
      CHECK (harvested_hectares IS NULL OR harvested_hectares >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_harvest_loads_weights_nonneg') THEN
    ALTER TABLE harvest_loads ADD CONSTRAINT chk_harvest_loads_weights_nonneg
      CHECK ((weight_kg IS NULL OR weight_kg >= 0)
         AND (net_weight_kg IS NULL OR net_weight_kg >= 0)
         AND (gross_weight_kg IS NULL OR gross_weight_kg >= 0)
         AND (tare_kg IS NULL OR tare_kg >= 0)
         AND (acopio_weight_kg IS NULL OR acopio_weight_kg >= 0)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rainfall_mm_range') THEN
    ALTER TABLE rainfall ADD CONSTRAINT chk_rainfall_mm_range
      CHECK (millimeters >= 0 AND millimeters <= 1000) NOT VALID;
  END IF;
END $$;
