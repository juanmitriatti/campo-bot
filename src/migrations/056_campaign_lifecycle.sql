-- 056: Campaign lifecycle — harvest as milestone, not closure
-- Three states: ACTIVE (end_date NULL, harvested_at NULL), HARVESTED (end_date NULL, harvested_at set), CLOSED (end_date set)

ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS harvested_at DATE;
ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS yield_kg NUMERIC;
ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS yield_notes TEXT;

-- Backfill: existing closed campaigns with harvest activities → set harvested_at = end_date
UPDATE plot_crops pc
SET harvested_at = pc.end_date
WHERE pc.end_date IS NOT NULL
  AND pc.harvested_at IS NULL
  AND EXISTS (
    SELECT 1 FROM domain_events de
    WHERE de.plot_crop_id = pc.id AND de.event_type = 'harvest'
  );
