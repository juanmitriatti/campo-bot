-- Análisis de datos con IA desde el dashboard (tab "Análisis de datos").
-- Plan mínimo Pro. Igual que en la 109: una feature nueva NO entra sola a
-- ningún plan, así que se siembra explícitamente.
INSERT INTO features (key, description)
VALUES ('data_analysis', 'Análisis de datos con IA desde el dashboard: preguntas libres sobre gastos, ingresos, actividades, cosechas, lluvias, hacienda y stock de una campaña')
ON CONFLICT (key) DO NOTHING;

INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM plans p
CROSS JOIN features f
WHERE f.key = 'data_analysis'
  AND p.name IN ('pro', 'pro_plus', 'enterprise')
ON CONFLICT DO NOTHING;
