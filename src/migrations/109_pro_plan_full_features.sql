-- Escalera de planes definida (Ago 2026): la diferencia entre Pro y Pro+ es
-- COMPARTIR CAMPO, no el registro de datos.
--
-- Hasta acá `pro` no tenía agronomy, audio, stock ni livestock: un plan de
-- $5.000 que no podía registrar una fumigación ni recibir un audio — las dos
-- cosas que la landing usa de gancho. El escalón intermedio era invendible.
--
--   pro       → todas las features MENOS sharing
--   pro_plus  → todas (sharing incluido)
--
-- Idempotente y por diferencia contra `features`: una feature nueva que se
-- agregue mañana NO entra sola a ningún plan (se habilita desde
-- /admin → Planes), así que esto no es una puerta trasera de gating.
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM plans p
CROSS JOIN features f
WHERE p.name = 'pro' AND f.key <> 'sharing'
ON CONFLICT DO NOTHING;

INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM plans p
CROSS JOIN features f
WHERE p.name = 'pro_plus'
ON CONFLICT DO NOTHING;
