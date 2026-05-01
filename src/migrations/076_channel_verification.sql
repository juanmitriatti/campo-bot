-- 076: Channel verification (WhatsApp OTP + Telegram deep-link)
--
-- Adds opt-in linking between web users (email + password) and the bot channels.
-- New rule: a phone_number / telegram_id is only "claimed" by a user once verified.
-- Existing users are grandfathered to verified=NOW() so they keep working.

-- 1. Add verification timestamps to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS whatsapp_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS telegram_verified_at TIMESTAMPTZ;

-- 2. Grandfather:
--    - Any existing user with a real phone_number (not the "tg_<id>" placeholder used
--      by Telegram-first users) is auto-verified for WhatsApp.
--    - Any existing user with a telegram_id is auto-verified for Telegram.
UPDATE users
SET whatsapp_verified_at = NOW()
WHERE phone_number IS NOT NULL
  AND phone_number !~ '^tg_'
  AND whatsapp_verified_at IS NULL;

UPDATE users
SET telegram_verified_at = NOW()
WHERE telegram_id IS NOT NULL
  AND telegram_verified_at IS NULL;

-- 3. Verification codes table.
--    For WhatsApp: 6-digit OTP.
--    For Telegram: opaque deep-link token used by /start verify_<token>.
CREATE TABLE IF NOT EXISTS channel_verifications (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('whatsapp', 'telegram')),
  code VARCHAR(64) NOT NULL,
  target VARCHAR(60),
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_verifications_user_pending
  ON channel_verifications (user_id, channel)
  WHERE verified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_channel_verifications_code_pending
  ON channel_verifications (code)
  WHERE verified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_channel_verifications_cleanup
  ON channel_verifications (expires_at)
  WHERE verified_at IS NULL;
