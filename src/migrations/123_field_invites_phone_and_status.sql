-- Migración 123: la invitación a un campo se ata a un TELÉFONO y se puede revocar.
--
-- QUÉ HABÍA: `field_invites` guardaba un código de 6 caracteres, su vencimiento
-- y quién lo usó. Nada más. Eso deja tres agujeros:
--
--   1. El código es una LLAVE AL PORTADOR: cualquiera que lo vea entra al campo.
--      El dueño lo manda por WhatsApp y queda reenviable para siempre.
--   2. No se puede REVOCAR. Un código emitido por error vive 7 días y no hay
--      forma de matarlo; la única salida es esperar o sacar al miembro después
--      de que entró.
--   3. No hay forma de saber POR DÓNDE se entregó, así que cuando exista la
--      plantilla aprobada de Meta no se va a poder distinguir un envío directo
--      de un link reenviado a mano.
--
-- `invited_phone` NULL sigue siendo válido: es el código abierto de siempre.
-- Los invites viejos siguen funcionando igual.

ALTER TABLE field_invites
  ADD COLUMN IF NOT EXISTS invited_phone   VARCHAR(32),
  ADD COLUMN IF NOT EXISTS invited_user_id INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS revoked_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by      INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS role            VARCHAR(20) NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS channel         VARCHAR(20);

COMMENT ON COLUMN field_invites.invited_phone IS
  'Teléfono canónico (549..., ver src/utils/phone.ts) al que se destinó la invitación. NULL = código abierto: lo redime cualquiera, que es el comportamiento legacy.';
COMMENT ON COLUMN field_invites.channel IS
  'Por dónde se entregó: wa_link (link wa.me que reenvía el dueño), code (código pelado en el chat) o template (plantilla aprobada de Meta, todavía no implementada).';

-- El rol viaja en la invitación para no tener que decidirlo al redimir. Hoy
-- solo hay owner/member; el CHECK evita que entre un valor inventado el día que
-- se agregue un rol nuevo sin tocar los dos lados.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_invites_role_check') THEN
    ALTER TABLE field_invites
      ADD CONSTRAINT field_invites_role_check CHECK (role IN ('owner', 'member'));
  END IF;
END $$;

-- El mismo CHECK que la migración 037 no puso en `field_members`. La columna es
-- VARCHAR libre: un typo ('Member', 'miembro') crea un rol fantasma que no
-- matchea ni el guard de dueño ni el de miembro.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM field_members WHERE role NOT IN ('owner', 'member')) THEN
    RAISE NOTICE '[MIGRATION 123] field_members con rol fuera de owner/member — CHECK no aplicado';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_members_role_check') THEN
    ALTER TABLE field_members
      ADD CONSTRAINT field_members_role_check CHECK (role IN ('owner', 'member'));
  END IF;
END $$;

-- Una sola invitación VIVA por (campo, teléfono). Sin esto, tocar "compartir"
-- tres veces deja tres códigos válidos para la misma persona y revocar uno no
-- sirve de nada.
--
-- El índice no puede mirar `expires_at > NOW()` (NOW() no es inmutable), así
-- que "viva" acá es "ni usada ni revocada". El vencimiento lo resuelve
-- `createInvite`, que revoca la anterior antes de insertar la nueva — y de paso
-- eso es lo que hace que "reenviar" funcione.
CREATE UNIQUE INDEX IF NOT EXISTS uq_field_invites_live
  ON field_invites (field_id, invited_phone)
  WHERE used_by IS NULL AND revoked_at IS NULL AND invited_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_field_invites_invited_phone
  ON field_invites (invited_phone) WHERE invited_phone IS NOT NULL;
