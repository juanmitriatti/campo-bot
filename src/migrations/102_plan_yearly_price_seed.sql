-- Precio anual inicial de pro_plus: ARS 100.000 (~30% off vs 12 × 12.000).
-- Editable desde /admin → Planes (input "Precio anual"). Solo se siembra si
-- nunca fue seteado, para no pisar un valor cargado a mano.
UPDATE plans
SET price_ars_yearly = 100000
WHERE name = 'pro_plus'
  AND price_ars_yearly IS NULL;
