-- 042: Add last_name column to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
