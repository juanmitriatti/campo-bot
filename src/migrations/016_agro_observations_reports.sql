-- agro_observations: field scouting notes by lot or field-level
CREATE TABLE IF NOT EXISTS agro_observations (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  field_id INT REFERENCES fields(id),
  plot_id INT REFERENCES plots(id),
  observation_text TEXT NOT NULL,
  category VARCHAR(30) NOT NULL DEFAULT 'general',
  source VARCHAR(10) NOT NULL DEFAULT 'text',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Observations by field + date (weekly report queries)
CREATE INDEX IF NOT EXISTS idx_agro_obs_field_created ON agro_observations(field_id, created_at DESC);

-- Observations by plot
CREATE INDEX IF NOT EXISTS idx_agro_obs_plot ON agro_observations(plot_id);

-- agronomic_reports: generated weekly PDF reports
CREATE TABLE IF NOT EXISTS agronomic_reports (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  field_id INT NOT NULL REFERENCES fields(id),
  week_number INT NOT NULL,
  year INT NOT NULL,
  pdf_path TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reports by field
CREATE INDEX IF NOT EXISTS idx_agro_reports_field ON agronomic_reports(field_id);

-- Reports by field + week (dedup / lookup)
CREATE INDEX IF NOT EXISTS idx_agro_reports_week ON agronomic_reports(field_id, week_number, year);
