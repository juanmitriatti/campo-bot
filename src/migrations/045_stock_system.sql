-- Stock management system: warehouses, stock items, and movements

CREATE TABLE IF NOT EXISTS warehouses (
  id SERIAL PRIMARY KEY,
  field_id INT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP DEFAULT NULL,
  deleted_by VARCHAR(50) DEFAULT NULL,
  UNIQUE(field_id, name)
);

CREATE TABLE IF NOT EXISTS stock_items (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'otros',
  current_quantity NUMERIC NOT NULL DEFAULT 0,
  unit VARCHAR(30) NOT NULL,
  min_stock NUMERIC DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP DEFAULT NULL,
  UNIQUE(warehouse_id, name)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  stock_item_id INT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  movement_type VARCHAR(20) NOT NULL,  -- 'entrada', 'salida', 'ajuste'
  quantity NUMERIC NOT NULL,
  reason VARCHAR(100),
  notes TEXT,
  expense_id INT REFERENCES expenses(id),
  domain_event_id INT REFERENCES domain_events(id),
  movement_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_warehouses_field ON warehouses(field_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_warehouse ON stock_items(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_user ON stock_items(user_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(stock_item_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(movement_date);

-- Feature gating
INSERT INTO features (key, description) VALUES ('stock', 'Gestión de stock e inventario') ON CONFLICT (key) DO NOTHING;
INSERT INTO plan_features (plan_id, feature_id)
  SELECT p.id, f.id FROM plans p, features f
  WHERE p.name IN ('pro_plus', 'enterprise') AND f.key = 'stock'
  ON CONFLICT DO NOTHING;
