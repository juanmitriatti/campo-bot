-- Migration 131: los nombres únicos son solo entre filas VIVAS (CAM-18, HAC-19).
--
-- Las UNIQUE de campos (user_id, name), lotes (field_id, name), feedlots
-- (field_id) y corrales (feedlot_id, name) incluían los borrados: borrar un
-- campo/lote/corral y volver a crearlo con el mismo nombre tiraba 23505 y el
-- usuario no podía rehacer lo que había borrado. Pasan a índices parciales
-- WHERE deleted_at IS NULL. Restaurar algo cuyo nombre ya usa una fila viva se
-- explica en el código (restoreField/restorePlot), nunca choca acá.

ALTER TABLE fields DROP CONSTRAINT IF EXISTS fields_user_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS fields_user_id_name_live
  ON fields (user_id, name) WHERE deleted_at IS NULL;

ALTER TABLE plots DROP CONSTRAINT IF EXISTS plots_field_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS plots_field_id_name_live
  ON plots (field_id, name) WHERE deleted_at IS NULL;

ALTER TABLE feedlots DROP CONSTRAINT IF EXISTS feedlots_field_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS feedlots_field_id_live
  ON feedlots (field_id) WHERE deleted_at IS NULL;

ALTER TABLE corrals DROP CONSTRAINT IF EXISTS corrals_feedlot_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS corrals_feedlot_id_name_live
  ON corrals (feedlot_id, name) WHERE deleted_at IS NULL;
