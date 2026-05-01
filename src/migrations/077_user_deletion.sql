-- 077: User account deletion
--
-- Adds a soft-deletion timestamp on users. Self-service account deletion
-- (DELETE /api/auth/me) sets deleted_at + status='deleted' + nulls out PII
-- (email, phone_number, telegram_id, password_hash) so the user can re-register
-- with the same email immediately if they want, while keeping their historical
-- data linked by user_id for the 30-day grace period.
--
-- A future cleanup job hard-deletes rows where deleted_at < NOW() - 30 days.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_deleted_at
  ON users (deleted_at) WHERE deleted_at IS NOT NULL;
