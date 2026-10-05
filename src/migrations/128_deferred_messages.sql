-- 128: mensajes proactivos diferidos por la ventana de 24 h de WhatsApp.
--
-- WhatsApp solo deja escribir texto libre a quien le habló al bot en las
-- últimas 24 h (fuera de eso hace falta una plantilla aprobada por Meta). Hasta
-- acá el bot mandaba igual: Meta rechazaba (#131009 / #131047) y el envío
-- quedaba como 'sent' o se perdía. En prod, el resumen semanal del 4 oct 2026
-- dio 224 errores 400 (auditoría oct 2026, CRN-2).
--
-- Decisión de producto (4 oct 2026): fuera de la ventana el mensaje NO se
-- manda; se guarda acá y se entrega la próxima vez que el usuario escribe
-- ("📬 Mientras no estabas…"). En paralelo se piden plantillas a Meta.
-- alert_history.status suma 'deferred' (sin CHECK: es VARCHAR libre).

CREATE TABLE IF NOT EXISTS deferred_messages (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  alert_type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  alert_history_id INT REFERENCES alert_history(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  delivered_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deferred_messages_pending
  ON deferred_messages (user_id, created_at)
  WHERE delivered_at IS NULL;
