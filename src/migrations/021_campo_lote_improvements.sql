-- 021: Campo/Lote UX & Data Integrity Improvements
-- Soft delete for fields/plots, deletion log, max fields

-- Soft delete columns on fields
ALTER TABLE fields ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(50) DEFAULT NULL;

-- Soft delete columns on plots
ALTER TABLE plots ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL;
ALTER TABLE plots ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(50) DEFAULT NULL;

-- Deletion history log table
CREATE TABLE IF NOT EXISTS deletion_log (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  entity_type VARCHAR(20) NOT NULL,
  entity_id INT NOT NULL,
  entity_name VARCHAR(100),
  parent_name VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  deleted_at TIMESTAMP DEFAULT NOW(),
  restored_at TIMESTAMP DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_deletion_log_user ON deletion_log(user_id, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_deletion_log_type ON deletion_log(entity_type, deleted_at DESC);

-- Max fields per user setting
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS max_fields INT DEFAULT 10;
