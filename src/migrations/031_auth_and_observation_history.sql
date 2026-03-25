-- Migration 031: Auth system + observation edit history
-- Adds password_hash and role to users, refresh_tokens table,
-- updated_at to agro_observations, and observation_history table.

-- Auth columns on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'end_user';

-- Unique email (partial — allows NULL for WhatsApp-only users)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users (email) WHERE email IS NOT NULL;

-- Refresh tokens (multi-device, rotation)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Observation edit tracking
ALTER TABLE agro_observations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS observation_history (
  id SERIAL PRIMARY KEY,
  observation_id INT NOT NULL REFERENCES agro_observations(id) ON DELETE CASCADE,
  previous_text TEXT NOT NULL,
  new_text TEXT NOT NULL,
  previous_category VARCHAR(30),
  new_category VARCHAR(30),
  edited_by INT NOT NULL REFERENCES users(id),
  edited_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_obs_history_obs ON observation_history(observation_id, edited_at DESC);
