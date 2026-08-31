-- Migración 116: datos oficiales del establecimiento (RENSPA / CUIG / titular).
--
-- Los movimientos y las declaraciones ganaderas en Argentina se hacen contra el
-- establecimiento, identificado por su RENSPA (Registro Nacional Sanitario de
-- Productores Agropecuarios). El CUIG (Clave Única de Identificación Ganadera)
-- es lo que identificaba las caravanas visuales antes de la identificación
-- electrónica y sigue vigente en el rodeo ya caravaneado
-- (Res. 841/2025 Arts. 12-13).
--
-- HONESTIDAD SOBRE EL FORMATO — esto importa:
-- La estructura del CII (15 dígitos = 032 + especie + NII) SÍ está confirmada en
-- el texto de la Res. 530/2025 Art. 15 y se valida en src/utils/animal-id.ts.
-- La máscara exacta de RENSPA y de CUIG NO se pudo confirmar en fuente oficial
-- primaria: el micrositio RENSPA de SENASA documenta el trámite, no el formato.
-- Por eso se guardan como texto SIN validador estricto. Inventar una máscara y
-- rechazar el RENSPA real de un productor sería peor que no validar.
-- TODO abierto y documentado en docs/ganaderia/senasa.md.
--
-- El largo de las columnas es holgado a propósito, por la misma razón.

ALTER TABLE fields ADD COLUMN IF NOT EXISTS renspa VARCHAR(24);
ALTER TABLE fields ADD COLUMN IF NOT EXISTS cuig VARCHAR(12);
ALTER TABLE fields ADD COLUMN IF NOT EXISTS senasa_titular VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_fields_renspa
  ON fields (renspa) WHERE renspa IS NOT NULL AND deleted_at IS NULL;
