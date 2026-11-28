-- Botones con datos y toques de un solo uso, en la base.
-- Vivían solo en memoria (10 y 15 min): un deploy o una demora dejaban el botón
-- "vencido" y se perdía lo que llevaba (el formulario detrás de «Guardar igual»,
-- el gasto que esperaba categoría, «Deshacer»), y un segundo toque después de un
-- reinicio volvía a ejecutar la operación. Se purgan a los 2 días.
CREATE TABLE IF NOT EXISTS callback_tokens (
  token      text PRIMARY KEY,
  owner      text,
  payload    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_callback_tokens_owner ON callback_tokens (owner, expires_at);

CREATE TABLE IF NOT EXISTS callback_uses (
  owner   text NOT NULL,
  key     text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, key)
);
CREATE INDEX IF NOT EXISTS idx_callback_uses_used_at ON callback_uses (used_at);
