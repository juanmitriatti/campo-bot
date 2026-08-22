-- Corta el loop infinito de recordatorios.
--
-- reminderTick solo marcaba la fila cuando el envío salía bien:
--
--   const ok = await send(...);
--   if (ok) { UPDATE ... SET status = 'sent' }
--
-- Si el envío fallaba (usuario sin canal, bot bloqueado, número cambiado), la
-- fila quedaba 'pending' y el cron —que corre CADA MINUTO— la volvía a tomar.
-- Sin contador, sin backoff y sin rendición.
--
-- En producción un solo recordatorio vencido de un usuario sin teléfono ni
-- Telegram generó 29.138 filas en alert_history a razón de 1.440 por día
-- durante 20 días: el 95% de toda la tabla.
--
-- Estos campos permiten backoff exponencial y un tope de reintentos. Nuevo
-- estado terminal 'failed' para las que agotan los intentos.
ALTER TABLE task_reminders
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

-- El índice de la query del tick filtra por status='pending'; agregar
-- last_attempt_at lo mantiene útil ahora que el backoff filtra por esa columna.
DROP INDEX IF EXISTS idx_task_reminders_due;
CREATE INDEX IF NOT EXISTS idx_task_reminders_due
  ON task_reminders (due_date, last_attempt_at) WHERE status = 'pending';
