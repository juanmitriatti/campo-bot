-- Migration 130: un checkout abierto es 'pending', no una prueba (CTA-2).
--
-- `startCheckout` cancelaba la suscripción vigente e insertaba una fila
-- 'trial' SIN `trial_ends_at` ANTES de que el usuario pagara: abrir el link de
-- MercadoPago y no pagar dejaba la cuenta en solo-lectura al instante, y esa
-- "prueba" no vencía nunca. Ahora el checkout queda 'pending' (fuera del
-- índice único de filas vivas) y la vigente sigue intacta hasta que MP
-- autoriza el pago: recién ahí se reemplaza.

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (
  status IN ('pending', 'trial', 'active', 'past_due', 'cancelled', 'expired')
);

-- Filas que dejó el bug: checkout sin pagar convertido en 'trial' eterno.
-- Sin pago autorizado (ningún evento procesado sin error) vuelven a 'pending';
-- el usuario recupera la fila anterior por el access-gate (que ignora pending).
UPDATE subscriptions s
   SET status = 'pending', updated_at = NOW()
 WHERE s.status = 'trial'
   AND s.provider <> 'trial'
   AND s.trial_ends_at IS NULL
   AND s.provider_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_pending
  ON subscriptions (user_id) WHERE status = 'pending';
