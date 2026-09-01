-- Catálogo público de planes (Ago 2026).
--
-- La landing dejó de tener los precios y los planes hardcodeados: los lee de
-- GET /api/plans/public. Para que "qué se muestra en la landing" sea una
-- decisión del admin y no un deploy, cada plan lleva sus propios flags:
--
--   is_public      → aparece en la landing (free queda FUERA: dejó de venderse,
--                    ahora es solo el destino del downgrade post-trial)
--   is_featured    → card destacada / badge "MÁS ELEGIDO"
--   custom_pricing → precio "A medida" + CTA de contacto en vez de checkout
--                    (enterprise se sigue asignando a mano desde admin)
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS is_public      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_featured    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS custom_pricing BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE plans SET is_public = TRUE                        WHERE name = 'pro';
UPDATE plans SET is_public = TRUE, is_featured = TRUE     WHERE name = 'pro_plus';
UPDATE plans SET is_public = TRUE, custom_pricing = TRUE  WHERE name = 'enterprise';
UPDATE plans SET is_public = FALSE                        WHERE name = 'free';

-- El plan a medida se vende como "Dedicado" (la landing lo nombra así). El
-- `name` sigue siendo 'enterprise': es la clave con la que lo buscan el
-- feature-gate, el checkout y el admin. Solo cambia la etiqueta comercial,
-- que además es editable desde /admin → Planes.
UPDATE plans SET display_name = 'Dedicado'
WHERE name = 'enterprise' AND display_name = 'Enterprise';

-- Un solo plan destacado: dos cards con "MÁS ELEGIDO" no significan nada.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_plans_featured
  ON plans (is_featured) WHERE is_featured;
