-- Migración 124: autoría de los registros en un campo COMPARTIDO.
--
-- LA DECISIÓN, para que quede en la base y no en un doc que se desactualiza:
-- `user_id` YA ES EL AUTOR. No hay resolución de dueño en ningún camino de
-- escritura: `saveExpense(userId, …)`, `saveDomainEvent(userId, …)`, lluvias,
-- monitoreos, stock y recordatorios guardan al usuario que llamó. Si B escribe
-- en el campo de A, queda `user_id = B`. O sea que el dato de "quién lo hizo"
-- ya es correcto en el 100 % de las filas.
--
-- Lo que estaba mal no era el dato sino la LECTURA: los filtros usaban
-- `user_id` también como clave de pertenencia ("mis datos"), fusionando los dos
-- significados. Eso se arregla en `accessible-fields.ts`, no con columnas nuevas.
--
-- Por eso NO se agregan `created_by` nuevos: los de las migraciones 112-115 se
-- escriben siempre como `createdBy ?? userId` (el mismo valor) y no los lee
-- nadie. `domain_events.created_by` sigue sin backfillearse, como manda la 115
-- (es la tabla más grande y el UPDATE completo toma un lock largo al arrancar).

-- EXCEPCIÓN: `harvest_loads` no tiene NINGUNA columna de usuario — cuelga de
-- `domain_event_id`. Y el dedup de cosecha ANEXA camiones al evento del mismo
-- día y lote, así que en un campo compartido los camiones que carga B quedan
-- colgando del evento de A y se le atribuyen a A. Es la única tabla donde el
-- autor realmente no se puede reconstruir.
--
-- Tabla chica, pero igual sin backfill masivo: para las filas viejas el actor
-- honesto es el del `domain_event` que las contiene, y eso se resuelve en la
-- query con un COALESCE. Inventar un autor retroactivo sería peor.
ALTER TABLE harvest_loads ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_harvest_loads_created_by
  ON harvest_loads (created_by) WHERE created_by IS NOT NULL;

COMMENT ON COLUMN harvest_loads.created_by IS
  'Quién cargó ESTE camión. La tabla no tiene user_id: el dedup de cosecha anexa camiones al evento del mismo día y lote, así que sin esta columna los camiones de un socio se le atribuyen al dueño del evento. NULL en filas previas a la migración 124 → el actor es el del domain_event.';

-- `plot_crops` NO lleva columna a propósito: el actor de una siembra es su
-- `domain_events` de tipo siembra. Una columna paralela sería una SEGUNDA
-- fuente de verdad del mismo hecho, y las dos podrían divergir.

-- La regla, escrita donde no se puede ignorar.
COMMENT ON COLUMN expenses.user_id IS
  'Quién REGISTRÓ la fila, no necesariamente el dueño del campo. La pertenencia la define field_id/plot_id vía accessibleFieldsSql() (src/domain/shared/accessible-fields.ts).';
COMMENT ON COLUMN incomes.user_id IS
  'Quién REGISTRÓ la fila, no necesariamente el dueño del campo. La pertenencia la define field_id/plot_id vía accessibleFieldsSql().';
COMMENT ON COLUMN domain_events.user_id IS
  'Quién REGISTRÓ la fila, no necesariamente el dueño del campo. La pertenencia la define plot_id (o corral_id → feedlot → campo) vía accessibleFieldsSql().';
COMMENT ON COLUMN agro_observations.user_id IS
  'Quién REGISTRÓ la fila, no necesariamente el dueño del campo. La pertenencia la define field_id/plot_id vía accessibleFieldsSql().';
COMMENT ON COLUMN crop_scoutings.user_id IS
  'Quién REGISTRÓ la fila, no necesariamente el dueño del campo. La pertenencia la define field_id/plot_id vía accessibleFieldsSql().';
COMMENT ON COLUMN rainfall.user_id IS
  'Quién REGISTRÓ la fila, no necesariamente el dueño del campo. La pertenencia la define field_id/plot_id vía accessibleFieldsSql().';
