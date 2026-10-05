-- Migration 129: la "última lluvia" es la última CARGADA, no la de fecha más nueva (AGR-6).
--
-- `saveRainfall` acumula en UNA fila por (usuario, campo, día): 10 mm a la
-- mañana + 20 mm a la tarde = 30 mm. "Corregí la última lluvia, eran 25"
-- pisaba el total del día (25 en vez de 35) y elegía la fila por fecha, así que
-- cargar "ayer 20 mm" después de "hoy 10 mm" corregía la de hoy.
--
-- `updated_at` ordena por carga; `last_added_mm` es lo que sumó la última
-- carga, para corregir o borrar solo eso.

ALTER TABLE rainfall ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
ALTER TABLE rainfall ADD COLUMN IF NOT EXISTS last_added_mm NUMERIC;

COMMENT ON COLUMN rainfall.last_added_mm IS
  'mm que sumó la última carga a esta fila (la fila acumula las lluvias del día). NULL = filas anteriores a la 129: se trata el total como una sola carga.';
