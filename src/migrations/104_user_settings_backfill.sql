-- 104_user_settings_backfill.sql
-- Backfill: usuarios registrados por la web nunca recibieron su fila de
-- user_settings (el bot solo la creaba en el auto-create por canal). Sin la
-- fila quedan excluidos de tips, resúmenes semanales/mensuales y alertas.
-- Idempotente; cubre a todos los usuarios existentes de una.
INSERT INTO user_settings (user_id)
SELECT id FROM users WHERE deleted_at IS NULL
ON CONFLICT (user_id) DO NOTHING;
