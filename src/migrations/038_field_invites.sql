-- 038: Field invite codes for sharing (replaces phone-based sharing)
CREATE TABLE IF NOT EXISTS field_invites (
  id SERIAL PRIMARY KEY,
  field_id INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  code VARCHAR(6) NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  used_by INTEGER REFERENCES users(id),
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_field_invites_code ON field_invites(code);
CREATE INDEX IF NOT EXISTS idx_field_invites_field_id ON field_invites(field_id);
