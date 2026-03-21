-- Add normalized_text column for deduplication of semantically identical observations
ALTER TABLE agro_observations ADD COLUMN IF NOT EXISTS normalized_text TEXT;

-- Index for dedup lookups: user + plot + normalized text + recent time
CREATE INDEX IF NOT EXISTS idx_agro_obs_dedup
  ON agro_observations(user_id, COALESCE(plot_id, 0), normalized_text, created_at DESC);
