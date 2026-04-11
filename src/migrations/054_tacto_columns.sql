-- 054: Add tacto (pregnancy check) columns to domain_events + seed activity dictionary

ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS pregnant_count INTEGER;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS open_count INTEGER;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS uncertain_count INTEGER;

INSERT INTO activity_dictionary (activity_type, display_name, tool_name, synonyms)
VALUES ('tacto', 'Tacto', 'log_tacto', E'tacto\npalpación\nrevisé preñez\ntacto rectal\ncontrol de preñez\nrevisión de preñez')
ON CONFLICT (activity_type) DO NOTHING;
