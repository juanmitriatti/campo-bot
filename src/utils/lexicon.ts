/**
 * Centralized conversational LEXICON — single source of truth for the synonym
 * sets that the deterministic correction/pivot/guard layer matches against.
 *
 * WHY THIS EXISTS: the same word-lists (correction cues, currency words, units,
 * delete verbs, copulas) were copy-pasted across ~10 regexes in
 * conversation-engine, pending-action-processor, pending-correction-interceptor
 * and conversation-guards. Adding a synonym meant editing every copy. Now a new
 * synonym is added in ONE place and every matcher benefits.
 *
 * All matchers are accent-insensitive (they normalize first), so "perdón" /
 * "perdon", "dólares" / "dolares", "más" / "mas" all match the same entry.
 */

/** Lowercase + strip accents/diacritics (keeps ñ→n collapse off — ñ is distinct). */
export function normLex(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Correction cues — "the user is correcting something they said".
// Add slang/variants HERE and every correction extractor picks them up.
// ─────────────────────────────────────────────────────────────────────────────
export const CORRECTION_CUES: readonly string[] = [
  'no', 'nop', 'nono', 'perdon', 'perdona', 'perdoname', 'disculpa', 'disculpame',
  'en realidad', 'realidad', 'mejor dicho', 'mas bien', 'mejor', 'cambio', 'cambia',
  'me equivoque', 'equivoque', 'corrijo', 'correccion', 'quise decir', 'queria decir',
  'uy', 'opa', 'ah no', 'mentira', 'esperate',
];

/** Regex-alternation fragment of the correction cues (accent-free, for embedding). */
export const CORRECTION_ALT = CORRECTION_CUES.map(c => c.replace(/ /g, '\\s+')).join('|');

/** Matches a leading correction cue (accent-insensitive). e.g. "perdón, ..." */
export const CORRECTION_PREFIX_RE = new RegExp(`^(?:${CORRECTION_ALT}),?\\s+`, 'i');

/** Does the text START with a correction cue? (normalized) */
export function startsWithCorrectionCue(text: string): boolean {
  return CORRECTION_PREFIX_RE.test(normLex(text));
}

// ─────────────────────────────────────────────────────────────────────────────
// Copula / "was/were" cues — "eran 5000", "fue ayer", "salió 200".
// ─────────────────────────────────────────────────────────────────────────────
export const COPULA_CUES: readonly string[] = [
  'eran', 'era', 'fue', 'fueron', 'son', 'es', 'seran', 'seria', 'serian',
  'salio', 'salieron', 'costo', 'costaron', 'costaba', 'costaban', 'iban a ser', 'iba a ser',
];
/** Alternation fragment for embedding in larger regexes (already accent-free). */
export const COPULA_ALT = COPULA_CUES.map(c => c.replace(/ /g, '\\s+')).join('|');

// ─────────────────────────────────────────────────────────────────────────────
// Currency lexicon (incl. Argentine slang).
// ─────────────────────────────────────────────────────────────────────────────
export const CURRENCY_USD_TERMS: readonly string[] = [
  'dolar', 'dolares', 'usd', 'u$d', 'u$s', 'u\\$d', 'verde', 'verdes', 'dolca', 'dolquis', 'green',
];
export const CURRENCY_ARS_TERMS: readonly string[] = [
  'peso', 'pesos', 'mango', 'mangos', 'moneda nacional', 'nacionales', 'ars', 'guita',
];
const USD_RE = new RegExp(`\\b(?:${CURRENCY_USD_TERMS.map(t => t.replace(/ /g, '\\s+')).join('|')})\\b`, 'i');
const ARS_RE = new RegExp(`\\b(?:${CURRENCY_ARS_TERMS.map(t => t.replace(/ /g, '\\s+')).join('|')})\\b`, 'i');

/** Detect a currency mention. Returns 'USD' | 'ARS' | null (accent-insensitive). */
export function detectCurrencyTerm(text: string): 'USD' | 'ARS' | null {
  const t = normLex(text);
  if (USD_RE.test(t)) return 'USD';
  if (ARS_RE.test(t)) return 'ARS';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agro dose/quantity units (NOT money). Used to tell "5 litros" (dose) from
// "5 mil" (money). Keep monetary multipliers OUT of here.
// ─────────────────────────────────────────────────────────────────────────────
export const UNIT_TERMS: readonly string[] = [
  'litros', 'litro', 'lts', 'lt', 'l', 'kg', 'kilos', 'kilo', 'cc', 'cm3', 'ml',
  'gramos', 'gr', 'g', 'tn', 'toneladas', 'tonelada', 'qq', 'quintales', 'quintal',
  'bolsas', 'bolsa', 'dosis', 'rollos', 'rollo', 'unidades', 'unidad', 'has', 'hectareas',
];
/** Capturing matcher: "<number> <unit>" → [_, number, unit]. */
export const QUANTITY_UNIT_RE = new RegExp(
  `\\b(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_TERMS.map(u => u.replace(/ /g, '\\s+')).join('|')})\\b`,
  'i',
);

/** Money hints — when present, a "correction" is about an AMOUNT, not a dose. */
export const MONEY_HINT_RE = /[$]|\bpesos?\b|\bd[oó]lar(?:es)?\b|\busd\b|\bmil\b|\bpalos?\b|\blucas?\b|\bmillon\w*\b|\bmango\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// Delete / undo verbs.
// ─────────────────────────────────────────────────────────────────────────────
export const DELETE_VERBS: readonly string[] = [
  'borr', 'elimin', 'saca', 'saque', 'quit', 'anul', 'deshac', 'remov',
];
const DELETE_RE = new RegExp(`\\b(?:${DELETE_VERBS.join('|')})\\w*`, 'i');
/** "dar de baja" is a multiword delete. */
const DELETE_PHRASE_RE = /\b(?:dar|dale|da)\s+de\s+baja\b/i;
export function hasDeleteVerb(text: string): boolean {
  const t = normLex(text);
  return DELETE_RE.test(t) || DELETE_PHRASE_RE.test(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deferral — "después te digo" durante un pending (ronda 3, Jul 2026).
// El usuario difiere la respuesta a un slot pendiente. NO es cancelación (el
// pending se mantiene) ni una respuesta (no se consume como valor). Distinto
// de NON_ANSWER_RE del pending-processor: eso incluye saludos y preguntas;
// esto es SOLO la intención explícita de contestar más tarde.
// ─────────────────────────────────────────────────────────────────────────────
const DEFERRAL_RE = new RegExp(
  '^(?:' +
  [
    'despu[eé]s\\s+te\\s+(?:digo|paso|aviso|confirmo)',
    'despu[eé]s\\s+(?:veo|lo\\s+veo|me\\s+fijo)',
    'luego\\s+te\\s+(?:digo|paso|aviso)',
    'm[aá]s\\s+tarde(?:\\s+te\\s+(?:digo|paso|aviso))?',
    'ahora\\s+no(?:\\s+(?:s[eé]|puedo|tengo))?',
    'ma[ñn]ana\\s+te\\s+(?:digo|paso|aviso|confirmo)',
    'todav[ií]a\\s+no\\s+(?:s[eé]|lo\\s+s[eé]|lo\\s+tengo)',
    'no\\s+s[eé]\\s+todav[ií]a',
    'cuando\\s+(?:sepa|lo\\s+tenga|me\\s+entere)\\s+te\\s+(?:digo|paso|aviso)',
    'dejame\\s+(?:pensar|ver|fijarme)',
    'me\\s+fijo\\s+y\\s+te\\s+(?:digo|paso|aviso)',
  ].join('|') +
  ')\\b',
  'i',
);
/** ¿El mensaje es un "te contesto después" (diferir, no cancelar ni responder)? */
export function isDeferralIntent(text: string): boolean {
  return DEFERRAL_RE.test(normLex(text).trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip a leading correction cue AND a leading "en"/article from a short answer,
 * returning the bare referent. "no, en el Norte" → "Norte"; "mejor lote A1" → "A1".
 * Used so plot/field/category answers carrying a correction prefix aren't dropped.
 */
export function stripAnswerPrefix(text: string): string {
  return text
    .replace(CORRECTION_PREFIX_RE, '')
    .replace(/^(en\s+(?:el\s+|la\s+|los\s+|las\s+)?|el\s+|la\s+)/i, '')
    .replace(/^lote\s+/i, '')
    .trim();
}
