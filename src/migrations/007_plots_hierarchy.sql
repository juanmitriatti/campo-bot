-- 007: Add hierarchical land structure (campos → lotes)

-- Add new columns to fields (campos)
ALTER TABLE fields ADD COLUMN IF NOT EXISTS hectares NUMERIC;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS location VARCHAR(200);

-- Create plots table (lotes, children of campos/fields)
CREATE TABLE IF NOT EXISTS plots (
  id SERIAL PRIMARY KEY,
  field_id INT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  area_hectares NUMERIC,
  soil_type VARCHAR(50),
  lat NUMERIC,
  lng NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(field_id, name)
);

-- Add plot_id foreign keys to transaction tables
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS plot_id INT REFERENCES plots(id);
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS plot_id INT REFERENCES plots(id);
ALTER TABLE rainfall ADD COLUMN IF NOT EXISTS plot_id INT REFERENCES plots(id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_plots_field_id ON plots(field_id);
CREATE INDEX IF NOT EXISTS idx_expenses_plot_id ON expenses(plot_id);
CREATE INDEX IF NOT EXISTS idx_incomes_plot_id ON incomes(plot_id);
CREATE INDEX IF NOT EXISTS idx_rainfall_plot_id ON rainfall(plot_id);
