-- Fecha de alta de cada usuario (lanzamiento, nov 2026): el panel de admin no
-- podía contar altas de la semana porque users no guardaba cuándo se creó.
--
-- Las cuentas existentes se completan con lo más viejo que hay de cada una: la
-- suscripción de prueba que se crea en toda alta, o el primer contacto de
-- adquisición. Sin ninguno de los dos queda NULL (no se inventa una fecha).
-- El DEFAULT va después del backfill: así las viejas no quedan como "de hoy", y
-- todas las altas nuevas (web, chat o admin) la reciben sin cambiar el código.
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE users u
   SET created_at = x.first_seen
  FROM (
    SELECT user_id, MIN(created_at) AS first_seen
      FROM (
        SELECT user_id, created_at FROM subscriptions
        UNION ALL
        SELECT user_id, created_at FROM acquisition_touches WHERE user_id IS NOT NULL
      ) s
     GROUP BY user_id
  ) x
 WHERE u.id = x.user_id AND u.created_at IS NULL;

ALTER TABLE users ALTER COLUMN created_at SET DEFAULT NOW();
