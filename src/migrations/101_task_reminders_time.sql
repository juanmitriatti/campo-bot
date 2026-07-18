-- Recordatorios con hora y minutos: "acordame el sábado a las 14:30 de
-- fumigar". due_time es AR-local y nullable — las filas viejas (NULL)
-- mantienen el comportamiento legacy (aviso a la mañana, franja 07-21).
-- El tick del scheduler pasa de horario a por-minuto para honrar minutos.
ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS due_time TIME;
