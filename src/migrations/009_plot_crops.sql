CREATE TABLE IF NOT EXISTS plot_crops (
  id SERIAL PRIMARY KEY,
  plot_id INT NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  crop VARCHAR(50) NOT NULL,
  season_year INT NOT NULL,
  season_type VARCHAR(10) NOT NULL DEFAULT 'gruesa',
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plot_crops_plot_id ON plot_crops(plot_id);
CREATE INDEX IF NOT EXISTS idx_plot_crops_active ON plot_crops(plot_id, end_date) WHERE end_date IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plot_crops_unique_active ON plot_crops(plot_id) WHERE end_date IS NULL;
