CREATE TABLE IF NOT EXISTS harvest_loads (
  id SERIAL PRIMARY KEY,
  domain_event_id INT NOT NULL REFERENCES domain_events(id),
  plot_crop_id INT REFERENCES plot_crops(id),
  driver_name VARCHAR(100) NOT NULL,
  weight_kg NUMERIC NOT NULL,
  destination VARCHAR(50),
  destinatario VARCHAR(100),
  truck_plate VARCHAR(20),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_harvest_loads_event ON harvest_loads(domain_event_id);
CREATE INDEX IF NOT EXISTS idx_harvest_loads_crop ON harvest_loads(plot_crop_id);
