-- Estado multi-turno de query_observations.
--
-- Era el único de los 8 dominios de consulta sin su columna: había 7
-- last_*_query (finance, scouting, harvest, stock, livestock, activity,
-- rainfall) y observaciones quedaba afuera, así que un follow-up sobre las
-- notas ("¿y en La Esperanza?") no podía heredar los filtros previos.
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS last_observation_query JSONB;
