-- Estado multi-turno de livestock_history (movimientos de hacienda).
--
-- last_livestock_query ya existe pero es de list_livestock (INVENTARIO actual:
-- "cuántas vacas tengo"). Los movimientos son otra pregunta —"cuándo nacieron",
-- "cuándo los moví"— y mezclar ambos estados haría que un refinamiento de una
-- heredara los filtros de la otra.
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS last_livestock_history_query JSONB;
