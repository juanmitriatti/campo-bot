-- Feedlots: max 1 per campo (UNIQUE field_id)
CREATE TABLE IF NOT EXISTS feedlots (
  id SERIAL PRIMARY KEY,
  field_id INT NOT NULL REFERENCES fields(id),
  user_id INT NOT NULL REFERENCES users(id),
  name VARCHAR(120) NOT NULL,
  capacity INT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP,
  UNIQUE (field_id)
);

CREATE INDEX IF NOT EXISTS idx_feedlots_field ON feedlots(field_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feedlots_user ON feedlots(user_id) WHERE deleted_at IS NULL;

-- Corrals: multiple per feedlot, unique name within feedlot
CREATE TABLE IF NOT EXISTS corrals (
  id SERIAL PRIMARY KEY,
  feedlot_id INT NOT NULL REFERENCES feedlots(id),
  name VARCHAR(120) NOT NULL,
  capacity INT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP,
  UNIQUE (feedlot_id, name)
);

CREATE INDEX IF NOT EXISTS idx_corrals_feedlot ON corrals(feedlot_id) WHERE deleted_at IS NULL;

-- Extend livestock_groups: add corral_id, make plot_id nullable
ALTER TABLE livestock_groups ADD COLUMN IF NOT EXISTS corral_id INT REFERENCES corrals(id);
ALTER TABLE livestock_groups ALTER COLUMN plot_id DROP NOT NULL;

-- CHECK: exactly one of plot_id or corral_id must be set
DO $$ BEGIN
  ALTER TABLE livestock_groups ADD CONSTRAINT chk_location_exclusive
    CHECK (
      (plot_id IS NOT NULL AND corral_id IS NULL) OR
      (plot_id IS NULL AND corral_id IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Replace old unique(plot_id, category, breed) with two partial indexes
DO $$ BEGIN
  ALTER TABLE livestock_groups DROP CONSTRAINT IF EXISTS livestock_groups_plot_id_category_breed_key;
EXCEPTION WHEN undefined_object THEN null; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_livestock_groups_plot
  ON livestock_groups (plot_id, category, breed)
  WHERE plot_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_livestock_groups_corral
  ON livestock_groups (corral_id, category, breed)
  WHERE corral_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_livestock_groups_corral
  ON livestock_groups (corral_id) WHERE deleted_at IS NULL;
