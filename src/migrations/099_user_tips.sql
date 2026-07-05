-- Tips contextuales de primera vez (descubrimiento por goteo).
-- El bot tiene ~100 herramientas y un usuario típico descubre 5: tras la
-- primera acción de cada tipo se muestra UN tip que enseña una capacidad
-- relacionada. Estado por usuario: qué tips ya vio (una sola vez cada uno),
-- cuándo fue el último (tope diario) y opt-out.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS tips_shown JSONB NOT NULL DEFAULT '[]';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_tip_date DATE;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_tip_count INT NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS tips_enabled BOOLEAN NOT NULL DEFAULT TRUE;
