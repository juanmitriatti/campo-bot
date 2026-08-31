-- Migración 112: la entidad Animal — capa individual OPCIONAL sobre los grupos.
--
-- MODELO HÍBRIDO. El sistema sigue siendo por grupos: `livestock_groups.count`
-- es la existencia y no cambia de semántica. `animals` es aditivo y opcional.
-- Los tres estados conviven y los tres son válidos:
--     grupo de 100 con   0 animales individualizados  → funciona igual que siempre
--     grupo de 100 con  60 animales individualizados  → parcial
--     grupo de 100 con 100 animales individualizados  → total
--
-- POR QUÉ AHORA: Res. SENASA 530/2025 (obligatoria desde 1-ene-2026) exige
-- identificación individual electrónica de bovinos. El productor ya está
-- obligado; hasta hoy AgroBot no podía representarlo.
--
-- NO se agrega ninguna FK desde `livestock_groups` hacia `animals`: la
-- dependencia es en un solo sentido. Si la capa individual falla, la agregada
-- sigue en pie.

DO $$ BEGIN
  CREATE TYPE animal_status AS ENUM ('activo','vendido','muerto','extraviado','transferido');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE animal_sex AS ENUM ('M','H');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Origen del dato. Es la materialización de `AnimalIdentificationSource`: todo
-- camino de entrada (chat, CSV, lector, formulario) queda trazado en la fila.
DO $$ BEGIN
  CREATE TYPE animal_source AS ENUM ('manual','whatsapp','csv_import','rfid_reader','form','api','derivado');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS animals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INT NOT NULL REFERENCES users(id),
  field_id INT REFERENCES fields(id),
  plot_id INT REFERENCES plots(id),
  corral_id INT REFERENCES corrals(id),
  -- Grupo actual. NULL es legítimo: un animal individualizado puede no estar
  -- asignado a ningún grupo (recién importado, sin ubicación conocida).
  group_id UUID REFERENCES livestock_groups(id),
  category livestock_category NOT NULL,
  sex animal_sex NOT NULL,
  breed_id INT REFERENCES livestock_breeds(id),
  breed_text VARCHAR(80),               -- lo que escribió el usuario, preservado
  birth_date DATE,
  status animal_status NOT NULL DEFAULT 'activo',
  origin VARCHAR(20),                   -- nacimiento | compra | importacion | alta_manual
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  exit_date DATE,
  mother_animal_id UUID REFERENCES animals(id),
  notes TEXT,
  source animal_source NOT NULL DEFAULT 'manual',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMP,
  -- Misma regla que livestock_groups.chk_location_exclusive, pero acá los DOS
  -- pueden ser NULL: un animal importado sin ubicación conocida es un caso real
  -- que hay que poder representar (y después reportar como inconsistencia).
  CONSTRAINT chk_animal_location CHECK (plot_id IS NULL OR corral_id IS NULL)
);

-- Índices dimensionados para 100.000 animales por usuario. Todos parciales para
-- no crecer con bajas ni borrados.
CREATE INDEX IF NOT EXISTS idx_animals_user_active
  ON animals (user_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_animals_group
  ON animals (group_id) WHERE deleted_at IS NULL AND group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_animals_plot
  ON animals (plot_id) WHERE deleted_at IS NULL AND status = 'activo' AND plot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_animals_corral
  ON animals (corral_id) WHERE deleted_at IS NULL AND status = 'activo' AND corral_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_animals_user_cat_sex
  ON animals (user_id, category, sex) WHERE deleted_at IS NULL AND status = 'activo';
CREATE INDEX IF NOT EXISTS idx_animals_mother
  ON animals (mother_animal_id) WHERE mother_animal_id IS NOT NULL;
-- Paginación keyset: OFFSET profundo sobre 100k filas no sirve.
CREATE INDEX IF NOT EXISTS idx_animals_keyset
  ON animals (user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- Contador desnormalizado: cuántos animales individuales tiene el grupo.
-- Se mantiene en la MISMA transacción que cualquier cambio de group_id/status.
-- Contar 100k filas en cada listado de grupos no escala; la deriva se detecta
-- por reconciliación (livestock-consistency.service) y se reporta, nunca se
-- asume correcta para una decisión.
ALTER TABLE livestock_groups ADD COLUMN IF NOT EXISTS individualized_count INT NOT NULL DEFAULT 0;

-- Lotes de identificaciones: el equivalente de `form_sessions` para una lectura
-- RFID / import CSV / lista pegada. Habilita el flujo preview → confirmar del
-- spec §4 ("Encontré 87 animales. 82 en Lote Norte… ¿Los muevo?").
CREATE TABLE IF NOT EXISTS animal_id_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INT NOT NULL REFERENCES users(id),
  source animal_source NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | previewed | applied | discarded
  intended_action VARCHAR(40),                    -- alta | movimiento | sanidad | pesaje | conciliacion
  raw_count INT NOT NULL DEFAULT 0,
  matched_count INT NOT NULL DEFAULT 0,
  unknown_count INT NOT NULL DEFAULT 0,
  invalid_count INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,     -- lista cruda + resolución por valor
  target JSONB,                                   -- destino propuesto (plot/corral/grupo/categoría)
  created_by INT REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMP,
  expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_animal_id_batches_user
  ON animal_id_batches (user_id, created_at DESC);
-- Guarda de idempotencia: aplicar dos veces el mismo batch duplicaría el
-- movimiento (el bug de lluvia acumulada de Ago 2026 en su versión ganadera).
CREATE INDEX IF NOT EXISTS idx_animal_id_batches_open
  ON animal_id_batches (user_id, status) WHERE status IN ('pending','previewed');
