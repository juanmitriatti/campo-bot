-- Recordatorios de labores/tareas futuras ("el sábado tengo que fumigar").
-- Antes el bot no tenía noción de PLAN: "el sábado fumigo" o se registraba
-- como fumigación hecha o se perdía en respond_text. Ahora → task_reminders
-- + tick horario del scheduler que avisa el día que corresponde.
CREATE TABLE IF NOT EXISTS task_reminders (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  due_date DATE NOT NULL,
  field_id INT REFERENCES fields(id) ON DELETE SET NULL,
  plot_id INT REFERENCES plots(id) ON DELETE SET NULL,
  -- pending → sent (aviso enviado) → done (usuario la marcó) | cancelled
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_reminders_due
  ON task_reminders (due_date) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_task_reminders_user
  ON task_reminders (user_id, status);
