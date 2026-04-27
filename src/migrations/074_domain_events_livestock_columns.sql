-- Add animal tracking columns to domain_events for livestock health, repro, and weighing events
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS animal_category VARCHAR(50);
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS animals_affected INTEGER;
