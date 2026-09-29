-- Migración 122: forma canónica de `users.phone_number`.
--
-- QUÉ HABÍA: tres productores escribían la MISMA columna UNIQUE con tres
-- formatos distintos.
--   1. El webhook de WhatsApp guarda `message.from` crudo → `5492364469135`.
--   2. `ChannelVerificationService.confirmWhatsApp` guardaba el resultado de su
--      `normalizeArPhone()` local → con `+` y, peor, SIN el 9 de celular
--      ("2364469135" salía `+542364469135`).
--   3. El alta manual del admin pide "como lo manda WhatsApp, sin +".
--
-- CONSECUENCIA EN PROD: quien vinculaba WhatsApp desde la web quedaba con un
-- número que el webhook nunca volvía a encontrar (`findVerifiedByPhone` compara
-- exacto) y al escribirle al bot recibía "creá tu cuenta" para siempre.
--
-- La canónica es `549` + 10 dígitos nacionales, sin `+`: es lo que manda Meta,
-- lo que ya tiene la mayoría de las filas, y de lo que se derivan las claves de
-- los pending stores (`wa:<phone>`).
--
-- `canonical_phone_ar()` es el ESPEJO SQL de `normalizePhone()` en
-- `src/utils/phone.ts`. Los dos lados se mantienen equivalentes con un test de
-- tabla, igual que `sqlNormalizedName` ↔ `compactEntityName` en entity-matcher.

CREATE OR REPLACE FUNCTION canonical_phone_ar(raw text) RETURNS text AS $$
DECLARE
  d   text;
  nat text;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  IF btrim(raw) = '' THEN RETURN NULL; END IF;
  -- El placeholder de Telegram es una identidad legítima, no un teléfono mal
  -- escrito: vuelve intacto.
  IF btrim(raw) ~ '^tg_' THEN RETURN btrim(raw); END IF;

  d := regexp_replace(raw, '\D', '', 'g');
  IF d = '' THEN RETURN NULL; END IF;

  IF left(d, 2) = '00' THEN d := substr(d, 3); END IF;

  IF left(d, 2) = '54' THEN
    nat := substr(d, 3);
    -- Ninguna característica argentina arranca con 9, así que el 9 de celular
    -- se puede sacar sin ambigüedad.
    IF left(nat, 1) = '9' THEN nat := substr(nat, 2); END IF;
  ELSE
    nat := d;
  END IF;

  -- 0 de larga distancia doméstica (0221...)
  WHILE left(nat, 1) = '0' LOOP nat := substr(nat, 2); END LOOP;

  -- "15" doméstico, DESPUÉS de la característica (0221 15 4123456). La
  -- característica es de 2, 3 o 4 dígitos → tres posiciones posibles.
  IF length(nat) = 12 THEN
    IF left(nat, 2) = '11' AND substr(nat, 3, 2) = '15' THEN
      nat := '11' || substr(nat, 5);
    ELSIF substr(nat, 4, 2) = '15' THEN
      nat := substr(nat, 1, 3) || substr(nat, 6);
    ELSIF substr(nat, 5, 2) = '15' THEN
      nat := substr(nat, 1, 4) || substr(nat, 7);
    END IF;
  END IF;

  IF length(nat) <> 10 THEN RETURN NULL; END IF;
  RETURN '549' || nat;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Normalización de las filas existentes.
--
-- `users` es chica (el lock dura milisegundos), así que esto sí corre en la
-- migración — al revés de `domain_events` en la 115.
--
-- SOLO se normaliza lo que NO colisiona: si `549X` y `+549X` son dos cuentas
-- distintas de la misma persona, fusionarlas mueve datos entre usuarios y eso
-- NO puede correr solo al arrancar el proceso (mismo criterio que
-- `merge-duplicate-breeds.ts`). Las colisiones se listan por NOTICE y las
-- resuelve `src/scripts/merge-duplicate-phone-users.ts`.
DO $$
DECLARE
  r         RECORD;
  canonical text;
  n_ok      int := 0;
  n_clash   int := 0;
BEGIN
  FOR r IN
    SELECT id, phone_number
      FROM users
     WHERE phone_number IS NOT NULL
       AND phone_number !~ '^tg_'
     ORDER BY id
  LOOP
    canonical := canonical_phone_ar(r.phone_number);

    IF canonical IS NULL OR canonical = r.phone_number THEN
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM users WHERE phone_number = canonical AND id <> r.id) THEN
      n_clash := n_clash + 1;
      RAISE NOTICE '[MIGRATION 122] colisión: user=% phone=% → % ya lo tiene otra cuenta',
        r.id, r.phone_number, canonical;
      CONTINUE;
    END IF;

    UPDATE users SET phone_number = canonical WHERE id = r.id;
    n_ok := n_ok + 1;
  END LOOP;

  RAISE NOTICE '[MIGRATION 122] normalizados=% colisiones=%', n_ok, n_clash;
END $$;

COMMENT ON COLUMN users.phone_number IS
  'Forma canónica 549 + 10 dígitos nacionales, SIN +. Fuente única de normalización: src/utils/phone.ts (normalizePhone) y su espejo SQL canonical_phone_ar(). Los usuarios creados por Telegram llevan el placeholder tg_<id>.';
