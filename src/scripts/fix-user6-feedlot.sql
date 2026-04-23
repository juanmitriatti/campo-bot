-- Fix user #6 data: create proper feedlot + corrals, move tacto, delete fake plots
-- Run manually AFTER deploying migration 058

-- 1. Create feedlot + corrals
INSERT INTO feedlots (name, field_id, user_id) VALUES ('Feedlot', 25, 6);
INSERT INTO corrals (feedlot_id, name)
SELECT fl.id, 'Corral ' || n
FROM feedlots fl, generate_series(1,4) AS n
WHERE fl.field_id = 25 AND fl.deleted_at IS NULL;

-- 2. Move tacto (domain_event id=30) to Corral 1
UPDATE domain_events SET
  corral_id = (SELECT c.id FROM corrals c JOIN feedlots fl ON fl.id = c.feedlot_id WHERE fl.field_id = 25 AND c.name = 'Corral 1'),
  plot_id = NULL
WHERE id = 30;

-- 3. Soft-delete fake plots (69-72)
UPDATE plots SET deleted_at = NOW(), deleted_by = 'admin-fix'
WHERE id IN (69,70,71,72) AND field_id = 25;
