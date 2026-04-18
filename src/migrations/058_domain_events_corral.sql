-- Add corral_id to domain_events for tacto/activities on feedlot corrals
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS corral_id INTEGER REFERENCES corrals(id);

-- Index for query performance
CREATE INDEX IF NOT EXISTS idx_domain_events_corral_id ON domain_events(corral_id) WHERE corral_id IS NOT NULL;
