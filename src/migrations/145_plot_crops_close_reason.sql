-- Por qué se cerró una campaña que no se cosechó (nov 2026).
-- Sembrar otro cultivo sobre uno activo cerraba la campaña anterior sin dejar
-- dicho qué había pasado con ella. Ahora el usuario lo elige y queda acá.
-- NULL = cierre normal (cosechada / cierre de campaña) o cierre anterior a esta columna.
ALTER TABLE plot_crops ADD COLUMN IF NOT EXISTS close_reason TEXT;
COMMENT ON COLUMN plot_crops.close_reason IS
  'Motivo de un cierre SIN cosecha: perdida | resiembra | error_de_carga. NULL = cierre normal.';
