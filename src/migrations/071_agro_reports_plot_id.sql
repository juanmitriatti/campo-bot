-- Store plot_id on agronomic_reports so per-plot reports are distinguishable
-- in the DB (until now only the PDF filename carried the plot suffix, which
-- meant the row for a plot-level report overwrote/collided with the field one).
ALTER TABLE agronomic_reports ADD COLUMN IF NOT EXISTS plot_id INT REFERENCES plots(id);
CREATE INDEX IF NOT EXISTS idx_agro_reports_plot ON agronomic_reports(plot_id) WHERE plot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agro_reports_user ON agronomic_reports(user_id, created_at DESC);
