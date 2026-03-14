-- Add audio feature for voice message processing
INSERT INTO features (key, description) VALUES ('audio', 'Procesamiento de mensajes de voz')
ON CONFLICT (key) DO NOTHING;

-- Grant audio to pro_plus and enterprise plans
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.name IN ('pro_plus', 'enterprise') AND f.key = 'audio'
ON CONFLICT DO NOTHING;
