-- Las restricciones de las migraciones 137 y 142 entraron como NOT VALID (solo
-- filas nuevas). Producción no tenía ninguna fila fuera de regla (27 nov 2026):
-- al validarlas pasan a garantizar también lo que ya está guardado.
-- Una que no se pueda validar queda como estaba y se avisa: nunca frena el arranque.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS tbl, conname
      FROM pg_constraint
     WHERE contype = 'c' AND NOT convalidated AND conname LIKE 'chk\_%'
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.tbl, c.conname);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'No se pudo validar % en %: hay filas fuera de regla', c.conname, c.tbl;
    END;
  END LOOP;
END $$;
