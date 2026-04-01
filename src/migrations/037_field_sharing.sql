-- 037: Field sharing (campos compartidos) for enterprise users
-- Allows multiple users to share access to the same campos/lotes

CREATE TABLE IF NOT EXISTS field_members (
  id SERIAL PRIMARY KEY,
  field_id INT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  role VARCHAR(20) NOT NULL DEFAULT 'member',  -- 'owner' | 'member'
  invited_by INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(field_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_field_members_user ON field_members(user_id);
CREATE INDEX IF NOT EXISTS idx_field_members_field ON field_members(field_id);

-- Backfill: every existing non-deleted field gets an owner row
INSERT INTO field_members (field_id, user_id, role, invited_by)
SELECT id, user_id, 'owner', user_id FROM fields WHERE deleted_at IS NULL
ON CONFLICT (field_id, user_id) DO NOTHING;
