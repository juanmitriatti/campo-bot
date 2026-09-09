-- Login / reset / registro case-insensitive por email.
--
-- El registro guardaba el email tal cual lo tipeaba el usuario y el login lo
-- buscaba con igualdad exacta, mientras que "olvidé mi contraseña" lo
-- lowercaseaba: un usuario registrado como "Juan@Gmail.com" no podía
-- recuperar la contraseña nunca (200 mudo, sin email). Desde ahora
-- auth.repository busca con LOWER(email); este índice sostiene esa query.
CREATE INDEX IF NOT EXISTS idx_users_email_lower
  ON users (LOWER(email)) WHERE email IS NOT NULL;

-- Normalizar las cuentas viejas guardadas con mayúsculas, SOLO cuando la
-- versión en minúsculas no choca con otra cuenta (el índice único verbatim
-- idx_users_email_unique haría fallar la migración entera). Las que chocan
-- quedan como están: el lookup case-insensitive las encuentra igual.
UPDATE users u
   SET email = LOWER(email)
 WHERE email IS NOT NULL
   AND email <> LOWER(email)
   AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND o.email = LOWER(u.email));
