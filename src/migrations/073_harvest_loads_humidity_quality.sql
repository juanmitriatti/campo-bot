-- Capture commercial humidity (used to compute weight discounts) and grain
-- quality metrics (protein, oil, gluten, test weight) per truckload. JSONB
-- for quality lets each crop store its own relevant metrics without bloating
-- the schema with crop-specific columns.

ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS humidity_pct NUMERIC(4,2)
  CHECK (humidity_pct IS NULL OR (humidity_pct >= 0 AND humidity_pct <= 50));

ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS quality_metrics JSONB;

COMMENT ON COLUMN harvest_loads.humidity_pct IS 'Humedad % medida en la carga (Argentina: base 13.5-14.5% según cultivo)';
COMMENT ON COLUMN harvest_loads.quality_metrics IS 'JSON crop-specific. Ej soja: {"oil_pct": 22.5}. Trigo: {"protein_pct": 11.8, "gluten_pct": 24, "test_weight_kg_hl": 78}. Girasol: {"oil_pct": 44}.';
