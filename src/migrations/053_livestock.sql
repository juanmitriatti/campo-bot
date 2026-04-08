-- Migration 053: Livestock (hacienda) management
-- Event-sourced cattle tracking with per-plot groups and atomic movements
-- Mirrors the stock_items + stock_movements architecture but keyed by plot + category + breed

-- ENUMs (no IF NOT EXISTS in CREATE TYPE — wrap in DO block for idempotency)
DO $$ BEGIN
  CREATE TYPE livestock_category AS ENUM (
    'vaca',
    'vaquillona',
    'ternero',
    'ternera',
    'novillo',
    'novillito',
    'toro',
    'torito',
    'buey'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE livestock_movement_type AS ENUM (
    'entrada',         -- compra / ingreso externo
    'salida',          -- venta / egreso externo
    'transferencia',   -- mover entre lotes (atómico, afecta 2 grupos)
    'muerte',          -- baja por muerte
    'nacimiento',      -- alta por parición
    'recategorizacion',-- ternero→novillito, etc. (afecta 2 grupos)
    'ajuste'           -- corrección manual de inventario
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- livestock_groups: current state per plot × category × breed
-- A "grupo" is the productive unit — cantidad is projected from the movement ledger.
CREATE TABLE IF NOT EXISTS livestock_groups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  field_id INT NOT NULL REFERENCES fields(id),
  plot_id INT NOT NULL REFERENCES plots(id),
  category livestock_category NOT NULL,
  breed VARCHAR(80),
  count INT NOT NULL DEFAULT 0 CHECK (count >= 0),
  avg_weight_kg NUMERIC(10,2),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP,
  -- A plot can only have ONE active group per (category, breed) combination.
  -- NULL breed is treated as a distinct bucket ("sin raza").
  UNIQUE (plot_id, category, breed)
);

CREATE INDEX IF NOT EXISTS idx_livestock_groups_user ON livestock_groups(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_livestock_groups_field ON livestock_groups(field_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_livestock_groups_plot ON livestock_groups(plot_id) WHERE deleted_at IS NULL;

-- livestock_movements: immutable ledger of every change
-- Transfers and recategorizations use BOTH source and dest; simple entries/exits use only one.
CREATE TABLE IF NOT EXISTS livestock_movements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  movement_type livestock_movement_type NOT NULL,
  source_group_id UUID REFERENCES livestock_groups(id),
  dest_group_id UUID REFERENCES livestock_groups(id),
  count INT NOT NULL CHECK (count > 0),
  avg_weight_kg NUMERIC(10,2),
  unit_price_ars NUMERIC(14,2),
  unit_price_usd NUMERIC(14,2),
  reason TEXT,
  notes TEXT,
  movement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  -- Enforce valid endpoint configuration per movement type at the DB level.
  CONSTRAINT chk_movement_endpoints CHECK (
    (movement_type = 'entrada'          AND source_group_id IS NULL AND dest_group_id IS NOT NULL) OR
    (movement_type = 'salida'           AND source_group_id IS NOT NULL AND dest_group_id IS NULL) OR
    (movement_type = 'muerte'           AND source_group_id IS NOT NULL AND dest_group_id IS NULL) OR
    (movement_type = 'nacimiento'       AND source_group_id IS NULL AND dest_group_id IS NOT NULL) OR
    (movement_type = 'transferencia'    AND source_group_id IS NOT NULL AND dest_group_id IS NOT NULL) OR
    (movement_type = 'recategorizacion' AND source_group_id IS NOT NULL AND dest_group_id IS NOT NULL) OR
    (movement_type = 'ajuste'           AND (source_group_id IS NOT NULL OR dest_group_id IS NOT NULL))
  )
);

CREATE INDEX IF NOT EXISTS idx_livestock_movements_source ON livestock_movements(source_group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_livestock_movements_dest ON livestock_movements(dest_group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_livestock_movements_user ON livestock_movements(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_livestock_movements_type ON livestock_movements(movement_type, created_at DESC);

-- Feature gating: livestock available on pro_plus and enterprise plans
INSERT INTO features (key, description)
VALUES ('livestock', 'Gestión de hacienda y ganado (vacas, terneros, etc.)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM plans p
CROSS JOIN features f
WHERE f.key = 'livestock'
  AND p.name IN ('pro_plus', 'enterprise')
ON CONFLICT DO NOTHING;
