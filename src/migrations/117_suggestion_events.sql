-- Sugerencias post-acción ("¿Y ahora?"): hasta acá no se podía saber si alguien
-- las tocaba — conversation_logs guarda el primer mensaje de la respuesta y los
-- taps solo se registraban para confirmar/cancelar. Una fila por sugerencia
-- enviada y una por tap sobre un botón del catálogo.
CREATE TABLE IF NOT EXISTS suggestion_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  channel VARCHAR(20),
  event VARCHAR(10) NOT NULL,          -- 'shown' | 'tap'
  suggestion_key VARCHAR(60),          -- clave del catálogo (shown) o null (tap)
  button_id VARCHAR(80),               -- callback_data tocado (tap)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suggestion_events_user_day
  ON suggestion_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestion_events_key
  ON suggestion_events (suggestion_key, event, created_at DESC);
