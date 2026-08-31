-- Migración 111: catálogo canónico de razas de hacienda.
--
-- POR QUÉ: `livestock_groups.breed` es texto libre Y forma parte del índice único
-- `(plot_id, category, breed)` (053/055). Sin normalización, "Angus", "angus" y
-- "Aberdeen Angus" son TRES grupos distintos en el mismo lote — el usuario carga
-- 20 y después 10 y ve dos filas en vez de una de 30. Es corrupción de inventario
-- que ya está en los datos, no un riesgo futuro.
--
-- ESTA MIGRACIÓN NO FUSIONA NADA. Solo crea el catálogo, lo siembra y agrega
-- `breed_id`, que se backfillea SOLO donde la resolución es inequívoca. La fusión
-- de grupos duplicados cambia counts y repunta el ledger de movimientos, así que
-- vive en `src/scripts/merge-duplicate-breeds.ts` con dry-run + confirmación
-- humana. Una migración que corre sola al arrancar no debe tocar existencias.
--
-- El seed de acá y BREED_CATALOG en `src/utils/livestock-breeds.ts` son espejos:
-- hay un test de paridad que falla si divergen.

CREATE TABLE IF NOT EXISTS livestock_breeds (
  id SERIAL PRIMARY KEY,
  code VARCHAR(40) UNIQUE NOT NULL,
  name VARCHAR(80) NOT NULL,
  species VARCHAR(20) NOT NULL DEFAULT 'bovino',
  kind VARCHAR(20) NOT NULL DEFAULT 'pura',   -- pura | cruza | desconocida | otra
  synonyms TEXT,                              -- separados por \n, igual que activity_dictionary
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 100,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_livestock_breeds_active
  ON livestock_breeds (sort_order, name) WHERE is_active;

INSERT INTO livestock_breeds (code, name, kind, sort_order, synonyms) VALUES
  ('angus', 'Angus', 'pura', 10, E'aberdeen angus\naberdeen\nangus negro\nangus colorado\nblack angus\nred angus\nan'),
  ('hereford', 'Hereford', 'pura', 20, E'polled hereford\nherford\nhereford polled\nhf'),
  ('braford', 'Braford', 'pura', 30, E'bradford'),
  ('brangus', 'Brangus', 'pura', 40, E'brangus negro\nbrangus colorado'),
  ('brahman', 'Brahman', 'pura', 50, E'brahaman\nbraman\ncebu\ncebu brahman'),
  ('limousin', 'Limousin', 'pura', 60, E'limousine\nlimusin'),
  ('charolais', 'Charolais', 'pura', 70, E'charolesa\ncharoles\ncharolais frances'),
  ('shorthorn', 'Shorthorn', 'pura', 80, E'short horn\ndurham'),
  ('holando', 'Holando Argentino', 'pura', 90, E'holando\nholstein\nholstein friesian\nholando argentino\nhollando\nvaca lechera'),
  ('jersey', 'Jersey', 'pura', 100, E'yersey'),
  ('nelore', 'Nelore', 'pura', 110, E'nellore'),
  ('criollo', 'Criollo', 'pura', 120, E'criolla\ncriollo argentino'),
  ('santa_gertrudis', 'Santa Gertrudis', 'pura', 130, E'santa gertrudiz\ngertrudis'),
  ('bonsmara', 'Bonsmara', 'pura', 140, E'bonsmara sudafricana'),
  ('simmental', 'Simmental', 'pura', 150, E'simental\nfleckvieh'),
  -- Salidas estructuradas: sin estas, el productor que no sabe la raza escribe
  -- cualquier cosa y volvemos al texto libre.
  ('cruza', 'Cruza', 'cruza', 900, E'cruzada\ncruzado\nmestizo\nmestiza\nmezcla\ncruza indefinida\novero'),
  ('desconocida', 'Desconocida', 'desconocida', 910, E'sin raza\nno se\nni idea\nsin identificar\nindefinida\ns/r'),
  ('otra', 'Otra', 'otra', 920, E'otro')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE livestock_groups ADD COLUMN IF NOT EXISTS breed_id INT REFERENCES livestock_breeds(id);
CREATE INDEX IF NOT EXISTS idx_livestock_groups_breed
  ON livestock_groups (breed_id) WHERE breed_id IS NOT NULL AND deleted_at IS NULL;

-- Backfill NO destructivo: solo enlaza `breed_id` cuando el texto actual resuelve
-- de forma inequívoca contra el nombre canónico o un sinónimo exacto. Deja
-- `breed` intacto — la unificación de la grafía y la fusión de grupos las hace
-- el script, bajo confirmación.
UPDATE livestock_groups lg
SET breed_id = b.id
FROM livestock_breeds b
WHERE lg.breed_id IS NULL
  AND lg.breed IS NOT NULL
  AND (
    LOWER(TRIM(lg.breed)) = LOWER(b.name)
    OR LOWER(TRIM(lg.breed)) = b.code
    OR LOWER(TRIM(lg.breed)) = ANY (string_to_array(b.synonyms, E'\n'))
  );
