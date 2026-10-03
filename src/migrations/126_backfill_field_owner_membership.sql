-- 126: fila `owner` en field_members para los campos que no la tienen.
--
-- La 037 la sembró para los campos que existían entonces, y desde entonces la
-- escribe `ensureOwnerMembership` al crear un campo. Pero quedaron campos sin
-- ella (creados por caminos que no la llamaban): 4 campos vivos de usuarios
-- activos en prod al 22/08/2026. Para esos, todo lo que miraba SOLO
-- field_members dejaba afuera al dueño — `getPlotById(lote, usuario)` devolvía
-- null y una cosecha "rindió 40 qq/ha" quedaba sin total porque no encontraba
-- la superficie del lote.
--
-- El código ya no depende de esta fila (getPlotById usa la regla única de
-- acceso: dueño O miembro); esto deja los datos parejos para cualquier otro
-- lector. Incluye campos borrados (soft delete): se pueden restaurar.
-- Idempotente.

INSERT INTO field_members (field_id, user_id, role, invited_by)
SELECT f.id, f.user_id, 'owner', f.user_id
  FROM fields f
 WHERE f.user_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM field_members fm
      WHERE fm.field_id = f.id AND fm.user_id = f.user_id
   )
ON CONFLICT (field_id, user_id) DO NOTHING;
