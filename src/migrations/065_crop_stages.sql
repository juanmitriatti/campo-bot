-- Phenological stages for crop growth alerts
CREATE TABLE IF NOT EXISTS crop_stages (
  id SERIAL PRIMARY KEY,
  crop VARCHAR(50) NOT NULL,
  stage_name VARCHAR(50) NOT NULL,
  stage_code VARCHAR(10),
  typical_days_from_sowing INT NOT NULL,
  alert_message TEXT NOT NULL
);

-- Seed data: Soja stages
INSERT INTO crop_stages (crop, stage_name, stage_code, typical_days_from_sowing, alert_message) VALUES
  ('soja', 'Emergencia', 'VE', 7, 'Verificá la emergencia y el stand de plantas. Controlá malezas tempranas.'),
  ('soja', 'Segundo nudo', 'V2', 14, 'Evaluá el stand definitivo y planificá control de malezas.'),
  ('soja', 'Cuarto nudo', 'V4', 28, 'Monitoreá plagas (isocas, chinches) y enfermedades foliares.'),
  ('soja', 'Inicio floración', 'R1', 45, 'Período crítico. Monitoreá plagas y enfermedades foliares. Evaluá fungicida.'),
  ('soja', 'Inicio llenado', 'R5', 80, 'Monitoreá chinches y enfermedades de fin de ciclo.'),
  ('soja', 'Madurez fisiológica', 'R7', 110, 'Evaluá fecha de cosecha. Controlá pérdidas.')
ON CONFLICT DO NOTHING;

-- Seed data: Maíz stages
INSERT INTO crop_stages (crop, stage_name, stage_code, typical_days_from_sowing, alert_message) VALUES
  ('maiz', 'Emergencia', 'VE', 7, 'Verificá la emergencia y el stand de plantas.'),
  ('maiz', 'Sexta hoja', 'V6', 30, 'Se define el rendimiento potencial. Monitoreá cogollero.'),
  ('maiz', 'Panojamiento', 'VT', 55, 'Período crítico para rendimiento. Cuidá el estrés hídrico.'),
  ('maiz', 'Floración', 'R1', 60, 'Máxima sensibilidad al estrés. Evaluá polinización.'),
  ('maiz', 'Grano pastoso', 'R4', 85, 'Monitoreá enfermedades de espiga y vuelco.')
ON CONFLICT DO NOTHING;

-- Seed data: Trigo stages
INSERT INTO crop_stages (crop, stage_name, stage_code, typical_days_from_sowing, alert_message) VALUES
  ('trigo', 'Macollaje', 'Z2', 30, 'Evaluá densidad de macollos y control de malezas.'),
  ('trigo', 'Encañazón', 'Z3', 60, 'Monitoreá roya y septoria. Evaluá fungicida.'),
  ('trigo', 'Espigazón', 'Z5', 85, 'Período crítico. Monitoreá fusariosis y roya.'),
  ('trigo', 'Grano lechoso', 'Z7', 100, 'Monitoreá enfermedades de espiga. Evaluá fecha de cosecha.')
ON CONFLICT DO NOTHING;

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS phenology_alerts BOOLEAN DEFAULT true;
