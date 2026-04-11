-- 054: Add tacto (pregnancy check) columns to domain_events + seed activity dictionary

ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS pregnant_count INTEGER;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS open_count INTEGER;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS uncertain_count INTEGER;

INSERT INTO activity_dictionary (activity_type, tool_name, synonyms)
VALUES ('tacto', 'log_tacto', 'tacto
palpación
revisé preñez
tacto rectal
control de preñez
revisión de preñez')
ON CONFLICT DO NOTHING;
