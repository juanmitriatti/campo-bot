-- Structured agronomic scouting (separate from agro_observations which stays free-text).
-- One row per scouting event. All metric fields are nullable so users register what they
-- have at the moment without needing to fill the whole form.

CREATE TABLE IF NOT EXISTS crop_scoutings (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  field_id INT REFERENCES fields(id),
  plot_id INT NOT NULL REFERENCES plots(id),
  plot_crop_id INT REFERENCES plot_crops(id),
  scouting_date DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Phenology
  stage_code VARCHAR(10),

  -- Weeds
  weed_coverage_pct NUMERIC(5,2) CHECK (weed_coverage_pct IS NULL OR (weed_coverage_pct >= 0 AND weed_coverage_pct <= 100)),
  weed_species TEXT[],

  -- Pests / disease
  pest_species VARCHAR(100),
  pest_severity_1_5 INT CHECK (pest_severity_1_5 IS NULL OR (pest_severity_1_5 BETWEEN 1 AND 5)),
  pest_affected_pct NUMERIC(5,2) CHECK (pest_affected_pct IS NULL OR (pest_affected_pct >= 0 AND pest_affected_pct <= 100)),

  -- Crop health
  soil_moisture_1_5 INT CHECK (soil_moisture_1_5 IS NULL OR (soil_moisture_1_5 BETWEEN 1 AND 5)),
  emergence_pct NUMERIC(5,2) CHECK (emergence_pct IS NULL OR (emergence_pct >= 0 AND emergence_pct <= 100)),
  plant_density_m2 NUMERIC(8,2) CHECK (plant_density_m2 IS NULL OR plant_density_m2 >= 0),

  notes TEXT,
  source VARCHAR(10) DEFAULT 'text',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP,
  edited_by INT REFERENCES users(id),
  deleted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crop_scoutings_plot_date ON crop_scoutings(plot_id, scouting_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crop_scoutings_plot_crop ON crop_scoutings(plot_crop_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crop_scoutings_user ON crop_scoutings(user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crop_scoutings_stage ON crop_scoutings(stage_code) WHERE stage_code IS NOT NULL AND deleted_at IS NULL;
