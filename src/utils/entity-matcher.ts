/**
 * entity-matcher.ts — FUENTE ÚNICA de verdad para matchear nombres de
 * entidades (lotes, campos, corrales) contra lo que escribió el usuario.
 *
 * Por qué existe: el matching de nombres estaba implementado ≥8 veces con
 * semánticas DISTINTAS (con/sin acentos, con/sin colapso de espacios, con/sin
 * pelado de artículos). Esa divergencia ya produjo pérdida de datos en vivo:
 * "El Bajo" → "Bajo" no matcheaba el lote real (Jun 2026), y los aliases se
 * escribían CON acentos pero se buscaban SIN ("Ñandú" nunca matcheaba).
 *
 * Reglas canónicas:
 *   1. Case-insensitive, acento-insensitive, whitespace-insensitive
 *      ("11 d" == "11D", "El Trébol" == "el trebol").
 *   2. El nombre LITERAL siempre se prueba PRIMERO. El pelado de artículo
 *      ("el norte" → "norte") es solo FALLBACK — nombres reales de lote
 *      arrancan con artículo ("El Bajo", "La Loma") y pelarlo de entrada
 *      los destruye.
 *   3. Convención "Lote X": un lote guardado como "Lote Norte" matchea la
 *      consulta "norte" (prefijo 'lote' aditivo en el lado SQL).
 *
 * Al agregar un call-site nuevo de matching, usá ESTE módulo — no escribas
 * otra normalización inline. El lado SQL y el lado JS deben mantenerse
 * equivalentes (hay un test de tabla que lo verifica).
 */

// Pares acentuado→plano para el lado SQL (TRANSLATE corre ANTES de LOWER
// porque LOWER en Postgres con locale C no baja no-ASCII). Cubre el set
// español real de nombres de campo/lote.
const SQL_ACCENTS_FROM = 'ÁÉÍÓÚÜÑáéíóúüñ';
const SQL_ACCENTS_TO = 'AEIOUUNaeiouun';

/**
 * Fragmento SQL que normaliza una expresión igual que compactEntityName():
 * sin acentos, minúsculas, sin NINGÚN espacio. Usar en AMBOS lados de la
 * comparación (columna y parámetro).
 */
export function sqlNormalizedName(expr: string): string {
  return `REGEXP_REPLACE(LOWER(TRANSLATE(${expr}, '${SQL_ACCENTS_FROM}', '${SQL_ACCENTS_TO}')), '\\s+', '', 'g')`;
}

/** Normalización canónica JS: minúsculas + sin acentos + espacios colapsados a uno. */
export function normalizeEntityName(s: string): string {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Como normalizeEntityName pero sin NINGÚN espacio — espejo JS exacto de sqlNormalizedName(). */
export function compactEntityName(s: string): string {
  return normalizeEntityName(s).replace(/ /g, '');
}

/**
 * Pela el artículo de apertura ("el norte" → "norte"). Devuelve el original
 * si quedara vacío. SOLO usar como fallback tras fallar el match literal.
 */
export function stripLeadingArticle(s: string): string {
  const stripped = String(s).replace(/^(?:el|la|los|las)\s+/i, '').trim();
  return stripped || String(s);
}

/**
 * Candidatos de búsqueda en orden: [literal, sin-artículo si difiere].
 * Encapsula la regla literal-primero/artículo-después.
 */
export function entityNameCandidates(s: string): string[] {
  const literal = String(s).trim();
  const stripped = stripLeadingArticle(literal);
  return stripped !== literal ? [literal, stripped] : [literal];
}
