-- 133: la campaña como unidad económica (análisis de cosecha, 12 oct 2026).
--
-- 1. plot_crops.crop_order: 1 = de primera, 2 = de segunda (soja después de
--    trigo en la misma campaña). Antes sembrar soja sobre un trigo cosechado
--    preguntaba "¿Reemplazo esa campaña?" y nada marcaba la soja como 2da.
--    NULL = no se sabe (campañas viejas sin antecesor).
-- 2. fx_rates: dólar histórico por día (fuente argentinadatos.com). Sin él la
--    plata de la campaña quedaba en dos columnas (ARS y USD) imposibles de
--    sumar: un gasto en pesos de marzo no se comparaba con una venta en dólares
--    de julio.
-- 3. Las campañas de fina se rotulan como la campaña agrícola que integran
--    (trigo 2025 = 2025/26). `season_year` no cambia: ya era el año de siembra.
-- Idempotente.

-- 0. getSeasonTypeForCrop comparaba con mayúsculas: "trigo" (como lo manda el
--    agente) caía en 'gruesa' y su año de campaña salía con la regla de la
--    gruesa. Se recalculan tipo y año de las finas mal rotuladas (regla fina:
--    año de siembra; enero es del año anterior).
UPDATE plot_crops
   SET season_type = 'fina',
       season_year = CASE WHEN EXTRACT(MONTH FROM start_date) = 1
                          THEN EXTRACT(YEAR FROM start_date)::int - 1
                          ELSE EXTRACT(YEAR FROM start_date)::int END
 WHERE season_type <> 'fina'
   AND translate(lower(trim(crop)), 'áéíóú', 'aeiou') IN ('trigo', 'cebada', 'avena', 'centeno');
UPDATE plot_crops SET season_type = 'perenne', season_year = EXTRACT(YEAR FROM start_date)::int
 WHERE season_type <> 'perenne' AND translate(lower(trim(crop)), 'áéíóú', 'aeiou') = 'alfalfa';

-- 0b. El año de campaña SALE de la fecha de siembra (getSeasonYear; campaign-sync
--     lo recalcula al editar). En prod hay sojas sembradas el 1 nov 2025 con
--     season_year 2026: con el Resumen por año agrícola habrían quedado fuera
--     de la 25/26. Gruesa: sep–dic = ese año, ene–ago = el anterior.
UPDATE plot_crops
   SET season_year = CASE WHEN EXTRACT(MONTH FROM start_date) >= 9
                          THEN EXTRACT(YEAR FROM start_date)::int
                          ELSE EXTRACT(YEAR FROM start_date)::int - 1 END
 WHERE season_type = 'gruesa' AND start_date IS NOT NULL
   AND season_year IS DISTINCT FROM (CASE WHEN EXTRACT(MONTH FROM start_date) >= 9
                                          THEN EXTRACT(YEAR FROM start_date)::int
                                          ELSE EXTRACT(YEAR FROM start_date)::int - 1 END);
UPDATE plot_crops
   SET season_year = CASE WHEN EXTRACT(MONTH FROM start_date) = 1
                          THEN EXTRACT(YEAR FROM start_date)::int - 1
                          ELSE EXTRACT(YEAR FROM start_date)::int END
 WHERE season_type = 'fina' AND start_date IS NOT NULL
   AND season_year IS DISTINCT FROM (CASE WHEN EXTRACT(MONTH FROM start_date) = 1
                                          THEN EXTRACT(YEAR FROM start_date)::int - 1
                                          ELSE EXTRACT(YEAR FROM start_date)::int END);

ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS crop_order SMALLINT;
DO $$ BEGIN
  ALTER TABLE plot_crops ADD CONSTRAINT plot_crops_crop_order_chk
    CHECK (crop_order IS NULL OR crop_order IN (1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Retroactivo: una gruesa sembrada dentro de los 60 días de COSECHADA una fina
-- en el mismo lote es de segunda (una fina reemplazada sin cosecha no cuenta);
-- el resto con antecesor conocido, de primera.
WITH ordered AS (
  SELECT pc.id, pc.season_type, pc.start_date,
         LAG(pc.season_type) OVER w AS prev_type,
         LAG(COALESCE(pc.harvest_ended_at::date, pc.harvested_at::date)) OVER w AS prev_end
    FROM plot_crops pc
  WINDOW w AS (PARTITION BY pc.plot_id ORDER BY pc.start_date, pc.id)
)
UPDATE plot_crops pc
   SET crop_order = CASE
         WHEN o.season_type = 'gruesa' AND o.prev_type = 'fina'
              AND o.prev_end IS NOT NULL AND o.start_date - o.prev_end BETWEEN 0 AND 60 THEN 2
         ELSE 1 END
  FROM ordered o
 WHERE o.id = pc.id AND pc.crop_order IS NULL AND o.prev_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS fx_rates (
  source     VARCHAR(20) NOT NULL,
  rate_date  DATE        NOT NULL,
  buy        NUMERIC(14, 4),
  sell       NUMERIC(14, 4) NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, rate_date)
);
