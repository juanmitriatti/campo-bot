-- 125: formularios CONVERSACIONALES por WhatsApp sobre form_sessions.
--
-- Meta todavía no aprueba los WhatsApp Flows: sin flow_id, WhatsApp no tenía
-- formularios. El colector conversacional reusa form_sessions como DRAFT
-- durable (cada respuesta válida se persiste al toque: un restart o un error
-- no pierde lo cargado) y confirma por el MISMO submitForm que el form web y
-- el Flow — una sola validación, un solo camino de persistencia.
--
-- mode:   web | flow | conversation (las filas viejas quedan 'web', que es lo
--         que eran o lo más parecido: nadie las lee por mode).
-- status: collecting | confirming | parked | submitted | cancelled.
--         NULL en filas web/flow (no tienen ciclo conversacional).
-- draft:  valores YA validados por FormDefinition + metadata del colector
--         (autoFilled, attempts). El submit re-valida todo igual.
ALTER TABLE form_sessions
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS awaiting_field TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- "Volvamos al gasto": última sesión conversacional viva del usuario.
CREATE INDEX IF NOT EXISTS idx_form_sessions_user_mode_status
  ON form_sessions (user_id, mode, status, updated_at DESC);

-- Purga diaria de sesiones vencidas (antes la tabla crecía para siempre).
CREATE INDEX IF NOT EXISTS idx_form_sessions_expires_at
  ON form_sessions (expires_at);
