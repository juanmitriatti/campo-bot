-- 051: Field geolocation + map tokens
ALTER TABLE fields ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS polygon JSONB;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS location_method VARCHAR(20);

CREATE TABLE IF NOT EXISTS map_tokens (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) UNIQUE NOT NULL,
  user_id INT NOT NULL REFERENCES users(id),
  field_name VARCHAR(100) NOT NULL,
  field_id INT REFERENCES fields(id),
  channel VARCHAR(20) NOT NULL,
  channel_id VARCHAR(50) NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_map_tokens_token ON map_tokens(token);
