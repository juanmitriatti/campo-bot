-- Add sowed_hectares to plot_crops
-- Tracks actual hectares sowed (may differ from total plot area)
-- NULL = sowed entire plot (backward compat)
ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS sowed_hectares NUMERIC NULL;
