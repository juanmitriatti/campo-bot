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

// ---------------------------------------------------------------------------
// Equivalencia de nombres: número escrito ↔ dígito, artículo y prefijo de tipo.
//
// Prod (12 oct 2026): un productor tenía los lotes «El Uno», «El Dos», «El
// Tres» y decía "lote 3" (Whisper y normalizePlotNumbers escriben el dígito).
// Nada lo resolvía: el validador vetó la fumigación del «El Tres» y "lote uno"
// contestando "¿en qué lote?" se buscó como «Uno». La clave canónica junta las
// formas en que se nombra el mismo lote: «El Tres» = «lote 3» = «3» = «tres».
// ---------------------------------------------------------------------------

const NUMBER_WORD_DIGITS: Record<string, string> = {
  uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6',
  siete: '7', ocho: '8', nueve: '9', diez: '10', once: '11', doce: '12',
  trece: '13', catorce: '14', quince: '15', dieciseis: '16', diecisiete: '17',
  dieciocho: '18', diecinueve: '19', veinte: '20',
};

/** "tres" → "3"; cualquier otra palabra queda igual (ya normalizada). */
export function numeralFold(word: string): string {
  const w = normalizeEntityName(word);
  return NUMBER_WORD_DIGITS[w] ?? w;
}

// Solo los prefijos que significan "lote": «campo 2» o «corral 2» NUNCA son
// equivalentes al lote «El Dos» (conservan el prefijo en la clave).
const KIND_PREFIX_RE = /^(?:lote|potrero|parcela|cuadro)\s+/;

/**
 * Clave canónica de un nombre de entidad: sin acentos ni mayúsculas, sin el
 * prefijo "lote/potrero/parcela/cuadro", sin artículo de apertura, con los números escritos
 * pasados a dígitos y sin espacios. Solo para COMPARAR nombres que el SQL
 * (`sqlNormalizedName`) no juntó; nunca para guardar.
 */
export function entityNameKey(s: string): string {
  let n = normalizeEntityName(s).replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(KIND_PREFIX_RE, '');
  const stripped = n.replace(/^(?:el|la|los|las)\s+/, '');
  if (stripped) n = stripped;
  return n.split(' ').map(numeralFold).join('');
}

/**
 * El ÚNICO nombre de `names` equivalente a `input` por `entityNameKey`, o null
 * si no hay ninguno o hay más de uno (dos lotes «1» y «El Uno» en la misma
 * lista no se adivinan).
 */
export function findEquivalentName(input: string, names: readonly string[]): string | null {
  const key = entityNameKey(input);
  if (!key) return null;
  const hits = names.filter((n) => entityNameKey(n) === key);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Una respuesta que nombra VARIOS lotes ("Lote Uno, lote dos y lote tres", "el
 * 1, el 2 y el 3", "Norte y Sur") → los nombres reales de `names`, en el orden
 * en que los dijo. null si hay menos de 2 partes o si alguna no resuelve a un
 * único lote: una lista a medio entender no se aplica a medias.
 */
export function resolvePlotList(text: string, names: readonly string[]): string[] | null {
  const norm = normalizeEntityName(text).replace(/[.;:!¡¿?]+/g, ' ').trim()
    .replace(/^(?:(?:en|a|para)\s+)?(?:(?:los|las)\s+)?(?:lotes?|potreros?)\s+(?=\S+\s*(?:,|\by\b|\be\b))/, '');
  const parts = norm
    .split(/\s*,\s*|\s+y\s+|\s+e\s+|\s+(?=(?:lote|potrero|parcela|cuadro)\s)/)
    .map((p) => p.replace(/^(?:(?:en|a|para)\s+)?/, '').trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const out: string[] = [];
  for (const part of parts) {
    const hit = findEquivalentName(part, names);
    if (!hit) return null;
    if (!out.includes(hit)) out.push(hit);
  }
  return out.length >= 2 ? out : null;
}

/** Texto → palabras normalizadas separadas por un espacio, con bordes. */
function wordPadded(s: string): string {
  return ` ${normalizeEntityName(s).replace(/[^a-z0-9ñ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/**
 * ¿El texto libre del usuario NOMBRA esta entidad (lote/campo/corral)?
 * Match por palabras completas con la normalización canónica (sin acentos,
 * sin mayúsculas), probando literal primero y sin artículo después, más la
 * convención "Lote X" ↔ "X". Un nombre corto o puramente numérico ("3", "A")
 * exige la palabra "lote"/"campo"/"corral" adelante o que el texto sea SOLO
 * el nombre — "compré 3 bolsas" no nombra al lote «3».
 *
 * La usa el colector conversacional de formularios; nunca escribir otra
 * normalización inline para esto.
 */
export function mentionsEntityName(text: string, name: string, kindWord: 'lote' | 'campo' | 'corral' = 'lote'): boolean {
  if (mentionsEntityNameRaw(text, name, kindWord)) return true;
  // «El Tres» nombrado "lote 3" (o «Lote 3» nombrado "lote tres").
  const fold = (s: string) => wordPadded(s).trim().split(' ').map(numeralFold).join(' ');
  const ft = fold(text), fn = fold(name);
  return (ft !== wordPadded(text).trim() || fn !== wordPadded(name).trim()) && mentionsEntityNameRaw(ft, fn, kindWord);
}

function mentionsEntityNameRaw(text: string, name: string, kindWord: 'lote' | 'campo' | 'corral'): boolean {
  const t = wordPadded(text);
  if (!t.trim()) return false;
  const names = new Set<string>();
  for (const cand of entityNameCandidates(name)) names.add(cand);
  const withoutKind = String(name).replace(new RegExp(`^${kindWord}\\s+`, 'i'), '').trim();
  if (withoutKind && withoutKind !== name) for (const cand of entityNameCandidates(withoutKind)) names.add(cand);
  for (const cand of names) {
    const n = wordPadded(cand).trim();
    if (!n) continue;
    const weak = n.length <= 1 || /^\d+$/.test(n);
    if (t.trim() === n) return true;
    if (weak) {
      if (t.includes(` ${kindWord} ${n} `)) return true;
      continue;
    }
    if (t.includes(` ${n} `)) return true;
    // "11D" escrito "11 d" (o "La Loma" escrito "laloma"): comparar compacto
    // contra 1-3 palabras consecutivas del texto.
    const compact = n.replace(/ /g, '');
    const words = t.trim().split(' ');
    for (let i = 0; i < words.length; i++) {
      let joined = '';
      for (let j = i; j < Math.min(words.length, i + 3); j++) {
        joined += words[j];
        if (joined === compact) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tolerancia fonética para nombres dictados por AUDIO.
//
// Prod (Tomás, 6 sep 2026): dictó "fumigué el lote del campo El Rehue" y
// Whisper transcribió "El Regué". El agente resolvió bien el campo real
// («el rehue») pero el output-validator lo vetó porque "rehue" no aparece
// literal en el texto → dos re-preguntas por el lote. La regla: un nombre
// REAL del usuario cuenta como mencionado si alguna palabra del texto suena
// igual (h muda, b/v, s/z/c, ll/y, g/j, qu/k) o queda a 1 edición.
// ---------------------------------------------------------------------------

/** Pliegue fonético del español rioplatense (sobre texto ya normalizado sin acentos). */
export function phoneticFoldEs(s: string): string {
  return normalizeEntityName(s)
    .replace(/h/g, '')
    .replace(/qu(?=[ei])/g, 'k')
    .replace(/c(?=[ei])/g, 's')
    .replace(/c/g, 'k')
    .replace(/z/g, 's')
    .replace(/v/g, 'b')
    .replace(/ll/g, 'y')
    .replace(/g(?=[ei])/g, 'j')
    .replace(/gu(?=[ei])/g, 'g')
    .replace(/x/g, 'ks')
    .replace(/(.)\1+/g, '$1');
}

function editDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * ¿`word` (palabra del texto del usuario) suena como `token` (parte de un
 * nombre real)? Solo para palabras de 4+ letras: con menos, una edición cambia
 * la palabra entera ("sur"/"sud").
 */
export function soundsLikeToken(word: string, token: string): boolean {
  const w = phoneticFoldEs(word);
  const t = phoneticFoldEs(token);
  if (w.length < 4 || t.length < 4) return false;
  return editDistance1(w, t);
}

/**
 * El ÚNICO nombre de `names` que está a un error de tipeo de `input` ("Mont" →
 * "Monte"), o null si no hay ninguno o hay más de uno. Nombres de 4+ letras
 * (mismo criterio que soundsLikeToken). Para resolver una respuesta a "¿en qué
 * lote?" sin ofrecer crear un lote con el nombre mal escrito (prod 12 oct 2026).
 */
export function uniqueNearName(input: string, names: readonly string[]): string | null {
  const target = compactEntityName(stripLeadingArticle(input));
  const hits = new Set<string>();
  for (const name of names) {
    const c = compactEntityName(name);
    if (c === target || soundsLikeToken(target, c)) hits.add(c);
  }
  if (hits.size !== 1) return null;
  const [only] = hits;
  return names.find((n) => compactEntityName(n) === only) ?? null;
}

/**
 * Clave de una EMPRESA (acopiador, comprador): "Cargill", "Cargil" y "Cargill
 * S.A." son la misma (FIN-25: partían el saldo por acopio en dos). Sin acentos
 * ni puntuación, sin la forma societaria (SA, SRL, SACIF, SAIC, SCA, "y Cía")
 * y con las letras dobles colapsadas (el error de tipeo más común en un nombre
 * propio). Solo para AGRUPAR: el nombre que se muestra es el que cargó el usuario.
 */
export function companyNameKey(s: string): string {
  return normalizeEntityName(s ?? '')
    .replace(/[.,'’&-]/g, ' ')
    .replace(/\b(?:s\s*a\s*c\s*i\s*f|s\s*a\s*i\s*c|s\s*r\s*l|s\s*c\s*a|s\s*a|y\s+cia|cia)\b/g, ' ')
    .replace(/\s+/g, '')
    .replace(/(.)\1+/g, '$1');
}
