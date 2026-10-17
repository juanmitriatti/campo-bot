-- Purga real de las cuentas dadas de baja (oct 2026, CTA-12). La baja (Mi
-- cuenta, admin o chat) es un soft delete con los datos personales en NULL;
-- a los 30 días el job nocturno borra los REGISTROS del usuario (gastos,
-- lotes, hacienda, conversaciones, documentos…). La fila de users queda como
-- lápida sin datos personales, porque las suscripciones y los pagos (que se
-- conservan como registro contable) la referencian. purged_at = ya purgada.
ALTER TABLE users ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;
