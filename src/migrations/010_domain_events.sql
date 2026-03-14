CREATE TABLE IF NOT EXISTS domain_events (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  plot_id INT REFERENCES plots(id),
  plot_crop_id INT REFERENCES plot_crops(id),
  event_type VARCHAR(30) NOT NULL,
  event_date DATE NOT NULL DEFAULT CURRENT_DATE,
  crop VARCHAR(50),
  product VARCHAR(100),
  product_type VARCHAR(30),
  quantity NUMERIC,
  unit VARCHAR(20),
  implement VARCHAR(50),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_events_user_id ON domain_events(user_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_plot_id ON domain_events(plot_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_plot_crop_id ON domain_events(plot_crop_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_event_type ON domain_events(event_type);
CREATE INDEX IF NOT EXISTS idx_domain_events_event_date ON domain_events(event_date);
