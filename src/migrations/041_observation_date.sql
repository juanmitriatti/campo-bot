-- Migration 041: Add observation_date column to agro_observations
ALTER TABLE agro_observations ADD COLUMN IF NOT EXISTS observation_date DATE DEFAULT CURRENT_DATE;
UPDATE agro_observations SET observation_date = created_at::date WHERE observation_date IS NULL;
