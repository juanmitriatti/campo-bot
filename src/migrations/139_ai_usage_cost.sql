-- Costo real de cada llamada de IA (nov 2026). El panel calculaba el costo de
-- todos los tokens con la tarifa de Haiku 4.5: al cambiar de modelo mostraba
-- cualquier cosa. Ahora cada fila guarda su modelo y su costo (model-pricing.ts).
-- Las filas anteriores quedan en NULL y se estiman a Haiku 4.5 al leer.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS model VARCHAR(60);
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12,6);
