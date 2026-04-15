-- Add grupo (sociedad) attribute to plots for grouping lotes
ALTER TABLE plots ADD COLUMN IF NOT EXISTS grupo VARCHAR(100) DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_plots_grupo ON plots(grupo) WHERE grupo IS NOT NULL;
