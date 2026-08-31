/**
 * animal-id.ts — FUENTE ÚNICA de verdad para identificadores individuales de
 * animales (RFID electrónico, caravana visual, CUIG, RP, interno).
 *
 * BASE NORMATIVA (verificada en fuente oficial, no inferida):
 *
 *   Res. SENASA 530/2025 (BO 21-jul-2025) — Art. 15 define el Código de
 *   Identificación Individual (CII) de 15 dígitos:
 *       032        país (ISO-3166, Argentina)
 *       + 2 díg.   especie (01 = bovino)
 *       + 10 díg.  NII (Número Individual Nacional), 0000000000..9999999999
 *   Art. 15(d) y Art. 8 referencian ISO-11784 / ISO-11785 / ISO-24631/1-3; el
 *   código almacenado en el dispositivo es binario natural de 64 bits.
 *   Art. 11: la caravana tipo "cinta" en machos muestra SOLO el NII (10 díg.),
 *   por eso un 10 dígitos suelto es una lectura legítima, no un error.
 *
 *   Res. SENASA 841/2025 (BO 3-nov-2025) — Art. 7 define el "binomio"
 *   (dispositivo electrónico + tarjeta visual); Art. 11 regula el reemplazo por
 *   pérdida, exigiendo en 11(d) referenciar el número anterior. De ahí que la
 *   identificación sea una ENTIDAD con historial (`animal_identifications`) y
 *   no una columna `rfid` en `animals`.
 *
 * PRINCIPIO DE DISEÑO: el sistema REGISTRA, no bloquea. Un identificador con
 * formato inesperado nunca aborta un alta — se guarda como `interno` y queda
 * marcado como revisable. Un productor con el celular en el corral y barro en
 * las manos no puede quedar trabado porque tipeó 14 dígitos.
 */

export type AnimalIdType = 'rfid' | 'caravana_visual' | 'cuig' | 'rp' | 'interno';

/** Código de país ISO-3166 numérico de Argentina, prefijo del CII. */
export const AR_COUNTRY_CODE = '032';
/** Código de especie bovina dentro del CII. */
export const SPECIES_BOVINE = '01';

export interface ParsedAnimalId {
  /** Lo que escribió/leyó el usuario, sin tocar. Se guarda en `value`. */
  raw: string;
  /** Solo dígitos y letras en mayúscula. Se guarda en `value_normalized` y es la clave de lookup. */
  normalized: string;
  /** Tipo inferido. Nunca `null`: lo no reconocido cae en `interno`. */
  idType: AnimalIdType;
  /** true solo para un CII de 15 dígitos bien formado. */
  isFullCii: boolean;
  /** NII de 10 dígitos, presente en CII completo y en NII suelto. */
  nii: string | null;
  countryCode: string | null;
  speciesCode: string | null;
  /** Motivo por el que NO es un CII válido. `null` si lo es. Es informativo, no bloqueante. */
  warning: string | null;
}

/**
 * Normaliza a la forma de lookup: sin espacios, guiones ni puntos, en mayúscula.
 * Los lectores RFID y los productores escriben el mismo número de N maneras
 * ("032 01 0001234567", "032-01-0001234567", "032010001234567") y las tres
 * tienen que resolver al mismo animal.
 */
export function normalizeAnimalId(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Interpreta un identificador crudo. NUNCA tira — devuelve siempre un
 * ParsedAnimalId, con `warning` explicando por qué no es un CII cuando aplica.
 */
export function parseAnimalId(raw: string | null | undefined): ParsedAnimalId {
  const rawStr = raw == null ? '' : String(raw);
  const normalized = normalizeAnimalId(rawStr);

  const base: ParsedAnimalId = {
    raw: rawStr,
    normalized,
    idType: 'interno',
    isFullCii: false,
    nii: null,
    countryCode: null,
    speciesCode: null,
    warning: null,
  };

  if (!normalized) {
    return { ...base, warning: 'Identificador vacío.' };
  }

  const allDigits = /^[0-9]+$/.test(normalized);

  if (allDigits && normalized.length === 15) {
    const countryCode = normalized.slice(0, 3);
    const speciesCode = normalized.slice(3, 5);
    const nii = normalized.slice(5);

    if (countryCode !== AR_COUNTRY_CODE) {
      // Un animal importado trae el código de otro país. Es un RFID válido bajo
      // ISO-11784 — solo no es argentino. Se acepta.
      return {
        ...base, idType: 'rfid', isFullCii: true, nii, countryCode, speciesCode,
        warning: `Código de país ${countryCode} (no ${AR_COUNTRY_CODE}/Argentina) — animal de origen extranjero.`,
      };
    }
    if (speciesCode !== SPECIES_BOVINE) {
      return {
        ...base, idType: 'rfid', isFullCii: true, nii, countryCode, speciesCode,
        warning: `Código de especie ${speciesCode} (no ${SPECIES_BOVINE}/bovino).`,
      };
    }
    return { ...base, idType: 'rfid', isFullCii: true, nii, countryCode, speciesCode };
  }

  if (allDigits && normalized.length === 10) {
    // NII suelto: es lo que muestra la caravana tipo cinta en machos
    // (Res. 530/2025 Art. 11). Lectura legítima, no un truncamiento.
    return { ...base, idType: 'rfid', nii: normalized };
  }

  if (allDigits) {
    return {
      ...base,
      idType: 'caravana_visual',
      warning: `${normalized.length} dígitos: no es un CII (15) ni un NII (10). Se guarda como caravana visual.`,
    };
  }

  return {
    ...base,
    idType: 'caravana_visual',
    warning: 'Identificador no numérico — se guarda como caravana visual.',
  };
}

/** Atajo: ¿es un CII de 15 dígitos argentino y bovino, sin ninguna observación? */
export function isValidCii(raw: string | null | undefined): boolean {
  const p = parseAnimalId(raw);
  return p.isFullCii && p.warning === null;
}

/** Formato legible "032 01 0001234567" para mostrarle al usuario. */
export function formatCii(raw: string | null | undefined): string {
  const p = parseAnimalId(raw);
  if (!p.isFullCii) return p.normalized || String(raw ?? '');
  return `${p.countryCode} ${p.speciesCode} ${p.nii}`;
}

/**
 * Reconstruye el CII argentino bovino a partir de un NII de 10 dígitos.
 * Devuelve null si el NII no tiene 10 dígitos.
 */
export function ciiFromNii(nii: string | null | undefined): string | null {
  const n = normalizeAnimalId(nii);
  if (!/^[0-9]{10}$/.test(n)) return null;
  return `${AR_COUNTRY_CODE}${SPECIES_BOVINE}${n}`;
}

/**
 * ¿Un texto pegado por el usuario es una LISTA de caravanas? Se usa para
 * interceptar el mensaje ANTES del agente: 87 números en un prompt queman
 * tokens y el modelo los mangla. La decisión tiene que ser determinística.
 *
 * Criterio: al menos `minLines` líneas no vacías, y al menos `ratio` de ellas
 * parecen un identificador (≥8 caracteres alfanuméricos, mayoría dígitos).
 */
export function looksLikeIdList(
  text: string | null | undefined,
  opts: { minLines?: number; ratio?: number } = {},
): boolean {
  const minLines = opts.minLines ?? 5;
  const ratio = opts.ratio ?? 0.8;
  if (!text) return false;

  const lines = String(text)
    .split(/[\r\n;,]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < minLines) return false;

  const idLike = lines.filter((l) => {
    const n = normalizeAnimalId(l);
    if (n.length < 8) return false;
    const digits = (n.match(/[0-9]/g) || []).length;
    return digits / n.length >= 0.8;
  }).length;

  return idLike / lines.length >= ratio;
}

/**
 * Parte un texto pegado en líneas, SIN filtrar ni deduplicar.
 *
 * Es lo que necesita un lote de lectura: la clasificación en
 * encontrados/desconocidos/repetidos/ilegibles la hace `resolveBatch`, y si acá
 * se descartan los repetidos y los ilegibles, el productor que pegó 90 líneas ve
 * "leí 87" y no puede cuadrar qué pasó con las otras 3.
 */
export function splitIdLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return String(text)
    .split(/[\r\n;,]+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Extrae los identificadores únicos de un texto pegado, preservando el orden de
 * lectura y reportando aparte los repetidos. Filtra los fragmentos demasiado
 * cortos para ser un identificador.
 *
 * Para un lote de lectura usá `splitIdLines`: acá se pierden los ilegibles, que
 * el resumen tiene que poder contar.
 */
export function extractIdList(text: string | null | undefined): { values: string[]; duplicates: string[] } {
  const values: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  if (!text) return { values, duplicates };

  for (const line of String(text).split(/[\r\n;,]+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const n = normalizeAnimalId(trimmed);
    if (n.length < 4) continue;
    if (seen.has(n)) {
      duplicates.push(n);
      continue;
    }
    seen.add(n);
    values.push(n);
  }
  return { values, duplicates };
}
