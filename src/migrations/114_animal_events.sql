-- Migración 114: línea de tiempo individual.
--
-- DECISIÓN CENTRAL: NO se duplica `domain_events`.
--
-- Sanidad, reproducción y pesaje ya viven en `domain_events` con
-- `animal_category` + `animals_affected` (migración 074). Un evento grupal
-- ("vacuné 50 vacas contra aftosa") SIGUE SIENDO UNA sola fila ahí. Los animales
-- que participaron son N filas acá que ENLAZAN a esa fila por `domain_event_id`.
-- Lo mismo con `livestock_movements`.
--
-- Consecuencias buscadas:
--   · toda query agregada existente sigue funcionando sin tocar una línea;
--   · no hay dos verdades sobre el mismo hecho;
--   · un pesaje grupal de 40 animales = 1 domain_event (la sesión) + 40
--     animal_events con el peso de cada uno. El promedio del grupo y el peso
--     individual salen del mismo hecho, no de dos registros que pueden divergir.
--
-- `numeric_value`/`text_value`/`unit`/`from_ref`/`to_ref` son un payload genérico
-- a propósito: agregar un tipo de evento nuevo no debe requerir una migración.

DO $$ BEGIN
  CREATE TYPE animal_event_type AS ENUM (
    'identificacion','reidentificacion',
    'ingreso','egreso_venta','egreso_muerte','nacimiento',
    'movimiento','cambio_grupo','cambio_categoria','cambio_establecimiento',
    'vacunacion','desparasitacion','tratamiento','revision_sanitaria',
    'pesaje','condicion_corporal',
    'servicio','inseminacion','diagnostico_prenez','parto','destete',
    'otro'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS animal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INT NOT NULL REFERENCES users(id),
  animal_id UUID NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
  event_type animal_event_type NOT NULL,
  event_date DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Enlace al hecho agregado que lo originó. Como mucho uno de los dos: un
  -- evento nace de un domain_event (sanidad/repro/pesaje) o de un movimiento de
  -- hacienda, nunca de ambos. Los dos NULL = evento puramente individual
  -- (identificación, condición corporal, cambio de estado).
  domain_event_id INT REFERENCES domain_events(id),
  livestock_movement_id UUID REFERENCES livestock_movements(id),

  numeric_value NUMERIC,          -- kg, condición corporal, dosis
  text_value VARCHAR(120),        -- vacuna, resultado de tacto, categoría nueva
  unit VARCHAR(20),
  from_ref VARCHAR(120),          -- "Lote Norte" / "ternero"
  to_ref VARCHAR(120),            -- "Lote Sur"  / "novillito"
  related_animal_id UUID REFERENCES animals(id),   -- cría, madre, padre

  source animal_source NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMP,

  CONSTRAINT chk_animal_event_link CHECK (
    NOT (domain_event_id IS NOT NULL AND livestock_movement_id IS NOT NULL)
  )
);

-- La línea de tiempo de un animal. Keyset por (event_date, id): dos eventos del
-- mismo día necesitan un desempate estable o la paginación repite o saltea.
CREATE INDEX IF NOT EXISTS idx_animal_events_timeline
  ON animal_events (animal_id, event_date DESC, id DESC) WHERE deleted_at IS NULL;

-- "¿qué animales pesé este mes?" / "¿cuáles tienen período de retiro vigente?"
CREATE INDEX IF NOT EXISTS idx_animal_events_type
  ON animal_events (user_id, event_type, event_date DESC) WHERE deleted_at IS NULL;

-- Expandir un hecho agregado a los animales que participaron.
CREATE INDEX IF NOT EXISTS idx_animal_events_domain
  ON animal_events (domain_event_id) WHERE domain_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_animal_events_movement
  ON animal_events (livestock_movement_id) WHERE livestock_movement_id IS NOT NULL;
