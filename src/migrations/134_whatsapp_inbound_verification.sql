-- 134: vincular WhatsApp mandándole el código AL bot (12 oct 2026).
--
-- El código de 6 dígitos lo mandaba el bot al número del usuario, pero Meta
-- solo entrega un mensaje libre dentro de las 24 h desde el último mensaje DEL
-- usuario, y no hay plantillas aprobadas: a quien nunca le escribió al bot
-- (justo quien se está registrando) no le llegaba nunca (error 131047, en
-- silencio — la pantalla decía "te mandamos el código").
--
-- Ahora la web muestra el código y un link wa.me con "verificar 123456"; el
-- usuario lo manda desde su WhatsApp y el webhook vincula el número que lo
-- mandó. Ese código está a la vista en la pantalla, así que NO puede servir
-- para confirmarlo escribiéndolo en la web (eso vincularía un número ajeno sin
-- probar que es tuyo): `direction` separa los dos caminos.
--   outbound = el bot manda el código, el usuario lo escribe en la web (viejo)
--   inbound  = la web muestra el código, el usuario se lo manda al bot
-- Idempotente.

ALTER TABLE channel_verifications
  ADD COLUMN IF NOT EXISTS direction VARCHAR(10) NOT NULL DEFAULT 'outbound';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_verifications_direction_check') THEN
    ALTER TABLE channel_verifications
      ADD CONSTRAINT channel_verifications_direction_check CHECK (direction IN ('outbound', 'inbound'));
  END IF;
END $$;
