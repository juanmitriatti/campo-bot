-- Remove ai_fallback entirely (it's a global toggle, not per-user)
DELETE FROM plan_features
WHERE feature_id = (SELECT id FROM features WHERE key = 'ai_fallback');
DELETE FROM features WHERE key = 'ai_fallback';

-- Add sharing feature
INSERT INTO features (key, description)
VALUES ('sharing', 'Campos compartidos')
ON CONFLICT (key) DO NOTHING;

-- Add sharing to enterprise plan only
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.name = 'enterprise' AND f.key = 'sharing'
ON CONFLICT DO NOTHING;
