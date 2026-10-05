-- Migration 132: el presupuesto tiene moneda (FIN-22/23, decisión de producto 5 oct 2026).
--
-- "presupuesto de 2000 dólares para gasoil" se guardaba como $2.000 pesos, y la
-- alerta sumaba los gastos en dólares como si fueran pesos ($90.030). Ahora cada
-- presupuesto guarda su moneda y la alerta compara solo los gastos de esa moneda
-- (sin conversión). Los existentes eran todos en pesos.

ALTER TABLE budgets ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'ARS';
