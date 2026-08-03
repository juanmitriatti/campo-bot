-- 105_form_sessions.sql
-- Sesiones de formularios estructurados (Telegram Mini App / WhatsApp Flows).
-- Token-based igual que map_tokens: corta vida, un solo uso, atado al usuario.
-- phone = clave interna de canal (tg_<chatId> / testbot_<id> / número WA) para
-- lock por usuario y stores de pendings al momento del submit.
CREATE TABLE IF NOT EXISTS form_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  prefill JSONB NOT NULL DEFAULT '{}'::jsonb,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  had_pending BOOLEAN NOT NULL DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_form_sessions_user ON form_sessions(user_id);

-- Variedad de siembra: la carga el formulario (el chat podrá sumarla a futuro).
ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS variety TEXT;
