-- Venta de grano "a fijar" (Sep 2026, QA siembra/cosecha P1-4).
--
-- "vendí 5 tn de soja a Cargill a fijar" es la forma más común de vender soja
-- en Argentina: se entrega la cantidad y el precio se cierra después. El
-- ingreso tiene que existir con monto 0 y price_status = 'a_fijar' para que
-- descuente del saldo en el acopio y aparezca en la lista; el precio llega
-- después con una edición. El CHECK de la migración 093 (amount > 0) lo
-- impedía: el bot se trababa en "¿Cuánto fue?" y la venta nunca se guardaba.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_incomes_amount_positive' AND conrelid = 'incomes'::regclass
  ) THEN
    ALTER TABLE incomes DROP CONSTRAINT chk_incomes_amount_positive;
  END IF;
  ALTER TABLE incomes
    ADD CONSTRAINT chk_incomes_amount_positive
    CHECK (amount > 0 OR (amount = 0 AND price_status = 'a_fijar')) NOT VALID;
END $$;
