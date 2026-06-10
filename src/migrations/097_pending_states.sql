-- Persistencia de los pending stores (antes solo en memoria del proceso).
-- Un restart/deploy borraba todos los pendings en vuelo: el usuario que estaba
-- respondiendo "¿en qué lote?" mandaba la respuesta y se trataba como mensaje
-- nuevo. Los stores siguen leyendo de su Map en memoria (API síncrona intacta);
-- esta tabla es el espejo write-through que los controllers hidratan al inicio
-- de cada mensaje (fill-if-missing), de modo que el estado sobrevive restarts.
CREATE TABLE IF NOT EXISTS pending_states (
  store TEXT NOT NULL,
  key TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store, key)
);

-- Limpieza oportunista por TTL (los pendings viven 5 min): índice para que el
-- sweep barato del scheduler pueda borrar filas viejas sin full scan.
CREATE INDEX IF NOT EXISTS idx_pending_states_updated_at ON pending_states (updated_at);
