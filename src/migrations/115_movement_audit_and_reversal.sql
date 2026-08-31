-- Migración 115: auditoría de actor y reversión estructurada de movimientos.
--
-- QUÉ HABÍA: `LivestockService.undoMovement` ya revierte por CONTRA-ASIENTO —
-- nunca borra el movimiento histórico, inserta el inverso. Eso está bien y no se
-- toca. Lo que falta es que la relación entre el original y su reversa sea un
-- dato y no una frase en `reason`, y que no se pueda revertir dos veces.
--
-- QUÉ FALTABA EN AUDITORÍA: `livestock_movements` solo tenía `user_id`, que es
-- el DUEÑO del campo. Con campos compartidos (`field_members`, migración 037) el
-- que registra el movimiento puede no ser el dueño, y hoy esa distinción se
-- pierde. `created_by` guarda quién lo hizo de verdad.

ALTER TABLE livestock_movements ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id);
ALTER TABLE livestock_movements ADD COLUMN IF NOT EXISTS reverses_movement_id UUID REFERENCES livestock_movements(id);
ALTER TABLE livestock_movements ADD COLUMN IF NOT EXISTS source animal_source NOT NULL DEFAULT 'manual';

-- Un movimiento se puede revertir UNA sola vez. Sin esto, dos taps del botón de
-- deshacer (doble toque, retry de Telegram, solape de deploy) aplican dos
-- contra-asientos y el inventario queda mal en silencio.
CREATE UNIQUE INDEX IF NOT EXISTS uq_movement_single_reversal
  ON livestock_movements (reverses_movement_id) WHERE reverses_movement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_livestock_movements_created_by
  ON livestock_movements (created_by) WHERE created_by IS NOT NULL;

-- Mismo hueco de auditoría en las otras dos tablas que escribe el módulo.
ALTER TABLE livestock_groups ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id);
ALTER TABLE domain_events    ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id);

-- Backfill conservador: para las filas ya existentes el único actor conocido es
-- el dueño. Es lo más honesto que se puede afirmar retroactivamente — no se
-- inventa un actor que no está registrado.
UPDATE livestock_movements SET created_by = user_id WHERE created_by IS NULL;
UPDATE livestock_groups    SET created_by = user_id WHERE created_by IS NULL;

-- `domain_events` NO se backfillea a propósito: es la tabla más grande del
-- sistema (toda la actividad agronómica) y un UPDATE de tabla completa dentro de
-- la migración toma un lock largo al arrancar el proceso. `created_by IS NULL`
-- se lee como "actor no registrado" en las filas viejas, que es exactamente lo
-- que sabemos de ellas.

