-- 078: Subscriptions + payment events
--
-- subscriptions: tracks the billing relationship per user. Status state machine:
--    trial -> active (paid)
--    trial -> expired (trial ran out, no payment)
--    active -> past_due (payment failed)
--    past_due -> active (payment recovered)
--    past_due -> cancelled (after grace period)
--    active -> cancelled (user cancelled; access until current_period_end)
-- A user can have at most one active row at a time.
--
-- payment_events: idempotent log of webhook hits from the payment provider.
-- The (provider, provider_event_id) tuple is unique so the same webhook can be
-- delivered twice without double-applying.

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INT NOT NULL REFERENCES plans(id),
  provider VARCHAR(20) NOT NULL,                              -- 'mercadopago' | 'manual' | 'trial'
  provider_subscription_id VARCHAR(120),                      -- MP preapproval id
  status VARCHAR(20) NOT NULL,                                -- trial|active|past_due|cancelled|expired
  billing_period VARCHAR(20) NOT NULL DEFAULT 'monthly',      -- monthly | yearly
  trial_ends_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscriptions_status_check CHECK (
    status IN ('trial', 'active', 'past_due', 'cancelled', 'expired')
  )
);

-- One non-terminal subscription per user (trial / active / past_due).
-- Cancelled and expired rows are kept for history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_active
  ON subscriptions (user_id) WHERE status IN ('trial', 'active', 'past_due');

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON subscriptions (status);

CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_id
  ON subscriptions (provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_trial_expiry
  ON subscriptions (trial_ends_at) WHERE status = 'trial';


CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  provider VARCHAR(20) NOT NULL,
  provider_event_id VARCHAR(120) NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  payload JSONB,
  processed_at TIMESTAMPTZ,
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_idempotency
  ON payment_events (provider, provider_event_id);

CREATE INDEX IF NOT EXISTS idx_payment_events_unprocessed
  ON payment_events (received_at) WHERE processed_at IS NULL;

-- Optional: yearly price (12-month commitment, usually with discount).
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS price_ars_yearly NUMERIC;
