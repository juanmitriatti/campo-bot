-- Migración 113: la identificación como ENTIDAD-EVENTO, no como columna.
--
-- POR QUÉ NO ES UN `rfid VARCHAR` EN `animals`:
-- Res. SENASA 841/2025 Art. 11 regula el reemplazo del "binomio" (dispositivo
-- electrónico + tarjeta visual, Art. 7). Perder solo la tarjeta permite o no
-- reemplazarla; perder el componente electrónico obliga a sustituir el binomio;
-- perder el binomio completo hace que el animal PIERDA su condición de trazable.
-- Y 11(d) exige que la identificación nueva referencie el número anterior.
-- Una caravana cambia durante la vida del animal y ese historial es el activo
-- regulatorio — una columna lo pisaría en cada reemplazo.
--
-- Estructura del valor (Res. 530/2025 Art. 15), validada en src/utils/animal-id.ts:
--     CII = 15 dígitos = 032 (país ISO-3166) + 01 (especie bovina) + NII (10)
-- La caravana tipo cinta en machos muestra SOLO el NII, así que un 10 dígitos
-- suelto es una lectura legítima y no un truncamiento.

DO $$ BEGIN
  CREATE TYPE animal_id_type AS ENUM ('rfid','caravana_visual','cuig','rp','interno');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS animal_identifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INT NOT NULL REFERENCES users(id),
  animal_id UUID NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
  id_type animal_id_type NOT NULL,
  device_type VARCHAR(20),                -- boton | bolo | inyectable | tarjeta | cinta
  value VARCHAR(40) NOT NULL,             -- tal cual lo ingresó/leyó el usuario
  value_normalized VARCHAR(40) NOT NULL,  -- sin separadores, mayúsculas — clave de lookup
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_date DATE NOT NULL DEFAULT CURRENT_DATE,
  removed_date DATE,
  removal_reason VARCHAR(20),             -- perdida | rotura | reemplazo | baja | error_carga
  -- Art. 11(d): la nueva identificación referencia la anterior.
  replaces_identification_id UUID REFERENCES animal_identifications(id),
  -- Art. 8: la colocación se declara a SENASA en 10 días hábiles. Se registra
  -- cuándo se declaró para poder conciliar y avisar lo que falta declarar.
  senasa_declared_at TIMESTAMP,
  source animal_source NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Unicidad del identificador VIGENTE dentro del universo del productor.
--
-- DECISIÓN: por usuario, NO global. Un CII es nacionalmente único, pero un
-- animal cambia de dueño legítimamente y ambos productores tendrán ese número
-- en su historia. Una unicidad global rompería la compra-venta. El duplicado
-- entre usuarios se detecta como observación de conciliación, no como
-- constraint que bloquee un alta.
CREATE UNIQUE INDEX IF NOT EXISTS uq_animal_ident_current
  ON animal_identifications (user_id, id_type, value_normalized)
  WHERE is_current AND removed_date IS NULL;

-- La query más caliente del sistema: resolver una lectura RFID a un animal.
CREATE INDEX IF NOT EXISTS idx_animal_ident_lookup
  ON animal_identifications (value_normalized) WHERE is_current;

-- Historial de identificaciones de un animal (incluye las retiradas).
CREATE INDEX IF NOT EXISTS idx_animal_ident_animal
  ON animal_identifications (animal_id, assigned_date DESC, id DESC);

-- Qué falta declarar a SENASA.
CREATE INDEX IF NOT EXISTS idx_animal_ident_undeclared
  ON animal_identifications (user_id, assigned_date)
  WHERE senasa_declared_at IS NULL AND is_current;
