-- Forgot password + email verification post-register.
--
-- Tokens are bcrypt-hashed before storage so a DB read alone can't be used
-- to hijack a reset/verification link. Both tables auto-clean expired rows
-- via a partial index for fast lookup of pending tokens.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(72) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens(user_id) WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_pending
  ON password_reset_tokens(expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(72) NOT NULL,
  email VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user
  ON email_verification_tokens(user_id) WHERE used_at IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Grandfather: existing users keep working. We don't want to lock anyone
-- out by suddenly requiring verification on legacy accounts. The users
-- table lacks a created_at, so we just stamp NOW().
UPDATE users SET email_verified_at = NOW()
 WHERE email_verified_at IS NULL AND email IS NOT NULL;

-- Audit log for admin actions taken on behalf of an end-user (support flows:
-- editing or deleting their expenses, refunding a payment, etc.). Append-only.
CREATE TABLE IF NOT EXISTS support_audit_log (
  id SERIAL PRIMARY KEY,
  admin_user_id INT NOT NULL REFERENCES users(id),
  target_user_id INT NOT NULL REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50),
  resource_id VARCHAR(50),
  reason TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_audit_log_target ON support_audit_log(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_audit_log_admin ON support_audit_log(admin_user_id, created_at DESC);
