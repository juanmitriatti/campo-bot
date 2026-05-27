/**
 * Correction pre-classifier.
 *
 * Detects high-confidence correction patterns ("no, era en lote X", "perdón
 * fue en X", "me equivoqué, era en lote 1C") server-side, BEFORE the agent
 * sees the message. When a pattern matches, the classifier emits a direct
 * `edit_last_activity` command — the agent never gets the chance to
 * misinterpret the message as a fresh registration.
 *
 * Conservative by design: only the highest-confidence patterns trigger.
 * False positives are worse than false negatives here — a false positive
 * blocks a legitimate registration; a false negative just lets the agent
 * try (and possibly succeed via existing prompt rules).
 *
 * Behind a flag (AGENT_CORRECTION_PRE_CLASSIFIER_ENABLED) for gradual
 * rollout.
 */

import { extractCropFromText } from '../utils/crops.js';

export interface DetectedCorrection {
  /** edit_last_activity payload — at least one of newPlot or newCrop is set. */
  newPlot?: string;
  newCrop?: string;
  /** Pattern that matched, for telemetry/logging only. */
  matchedPattern: string;
}

const COMBINING_MARKS = /[̀-ͯ]/g;
function normalize(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().trim();
}

const CORRECTION_PREFIX = /^(no|perdon|disculpa|disculpame|me\s+equivoque|en\s+realidad)\b/;

/**
 * Patterns that signal a plot correction. Patterns run against accent-
 * stripped + lowercased text (the `normalize()` function), so source-encoding
 * variations of accents don't matter. Captured group 1 = new plot identifier
 * (in normalized form — the handler resolves it via PlotDiscoveryService
 * which is already case/accent-insensitive).
 */
// Capture group 1 = keyword (lote/campo/parcela/potrero) when present, else
// undefined. Capture group 2 = candidate. Knowing whether the keyword fired
// lets us safely skip the category-stoplist check when the user was explicit
// ("no, era en lote Sueldos" stays a plot correction even if "sueldos" is
// in the stoplist — they literally named their lote "Sueldos").
const PLOT_CORRECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: 'no_era_fue_en',
    re: /^\s*no\s*,?\s+(?:era|fue|fui|fuimos)\s+en\s+(?:el\s+|la\s+)?(lote|campo|parcela|potrero)?\s*([\p{L}\p{N}][\p{L}\p{N}\s\-]*?)\s*[.!?]?\s*$/u,
  },
  {
    name: 'no_verb_en',
    re: /^\s*no\s*,?\s+(?:las\s+|los\s+|lo\s+|la\s+)?(?:sembre|sembramos|coseche|cosechamos|fumigue|fumigamos|fertilice|fertilizamos|are|aramos|regue|regamos)\s+en\s+(?:el\s+|la\s+)?(lote|campo|parcela|potrero)?\s*([\p{L}\p{N}][\p{L}\p{N}\s\-]*?)\s*[.!?]?\s*$/u,
  },
  {
    name: 'perdon_era_en',
    re: /^\s*(?:perdon|disculpa|disculpame)\s*,?\s+(?:era|fue|fui)\s+en\s+(?:el\s+|la\s+)?(lote|campo)?\s*([\p{L}\p{N}][\p{L}\p{N}\s\-]*?)\s*[.!?]?\s*$/u,
  },
  {
    name: 'me_equivoque_era_en',
    re: /^\s*me\s+equivoque\s*,?\s+(?:era|fue|fui)\s+en\s+(?:el\s+|la\s+)?(lote|campo)?\s*([\p{L}\p{N}][\p{L}\p{N}\s\-]*?)\s*[.!?]?\s*$/u,
  },
];

const CROP_CORRECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: 'no_era_fue_crop',
    re: /^\s*no\s*,?\s+(?:era|fue|fueron|son|es)\s+(\p{L}+)\s*[.!?]?\s*$/u,
  },
  {
    name: 'perdon_era_crop',
    re: /^\s*(?:perdon|disculpa)\s*,?\s+(?:era|fue|es)\s+(\p{L}+)\s*[.!?]?\s*$/u,
  },
];

/**
 * Detect a correction pattern. Returns null when the text doesn't look like a
 * correction or when nothing meaningful can be extracted.
 *
 * The text must:
 *   - Start with a correction prefix (no/perdón/disculpa/me equivoqué).
 *   - Match one of the structural patterns.
 *   - For plot corrections: the candidate name must be a non-empty token.
 *     The handler later resolves it against the user's actual plot list and
 *     asks if it can't disambiguate — same as for any plot reference.
 *   - For crop corrections: the candidate must resolve to a known crop via
 *     `extractCropFromText`.
 */
export function detectCorrection(text: string): DetectedCorrection | null {
  if (!text || text.trim().length === 0) return null;

  // Run patterns on the accent-stripped, lowercased form so encoding
  // variants of "perdón" / "maíz" can't slip through.
  const normalized = normalize(text);

  if (!CORRECTION_PREFIX.test(normalized)) return null;

  for (const { name, re } of PLOT_CORRECTION_PATTERNS) {
    const match = normalized.match(re);
    if (match) {
      const keywordMatched = !!match[1];        // "lote" / "campo" / etc. fired
      const rawCandidate = match[2]?.trim();
      if (!rawCandidate) continue;
      const candidate = stripCommonNoise(rawCandidate);
      if (!candidate) continue;
      if (isLonePronoun(candidate)) continue;
      // Don't treat known expense/income category words as plot names UNLESS
      // the user was explicit with the keyword (then we trust they meant a
      // plot literally named that). Without the keyword the regex is too
      // greedy: "no, era en sueldos" would otherwise be routed as a plot
      // correction with newPlot=Sueldos, and the handler would fail with
      // "no encontré el lote sueldos", swallowing what was clearly a
      // CATEGORY correction.
      if (!keywordMatched && looksLikeCategoryWord(candidate)) continue;
      // Recover the source-form spelling from the original text so the
      // handler sees what the user actually typed (case, accents).
      const recovered = recoverFromOriginal(candidate, text) ?? titleCase(candidate);
      return { newPlot: recovered, matchedPattern: name };
    }
  }

  for (const { name, re } of CROP_CORRECTION_PATTERNS) {
    const match = normalized.match(re);
    if (match) {
      const word = match[1]?.trim();
      if (!word) continue;
      const crop = extractCropFromText(word);
      if (!crop) continue;
      return { newCrop: crop, matchedPattern: name };
    }
  }

  return null;
}

function recoverFromOriginal(normalizedCandidate: string, originalText: string): string | null {
  // Look for a span in the original text whose normalized form matches.
  // Cheap approach: word-boundary search on the original, then verify
  // normalized equality. Handles case + accent recovery for multi-word
  // candidates ("don pedro" → "Don Pedro").
  const tokens = normalizedCandidate.split(/\s+/);
  const re = new RegExp(
    tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'),
    'i',
  );
  const m = originalText.match(re);
  return m ? m[0].trim() : null;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map(w => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function stripCommonNoise(s: string): string {
  // Remove trailing words that aren't part of a plot identifier.
  const cleaned = s.replace(/\s+(en\s+realidad|por\s+supuesto)\s*$/i, '').trim();
  return cleaned;
}

function isLonePronoun(s: string): boolean {
  return /^(ah[ií]|all[aá]|all[ií]|ese|esa|aqu[ií]|aca|ah[ií]\s+mismo)$/i.test(s);
}

/**
 * Words that signal a CATEGORY correction (not a plot correction). When the
 * user says "no, era en sueldos" / "no, era en semillas" they're correcting
 * the expense category — not naming a plot. Without this check the regex
 * "no era en X" would route them as `edit_last_activity(newPlot=sueldos)`,
 * which fails since no plot has that name.
 *
 * List covers the typical expense categories (Combustible, Sueldos, etc.),
 * common income categories (Cosecha, Venta), and frequent product nouns
 * (gasoil, semillas, herbicida, etc.) that show up in correction phrases.
 * All entries are accent-stripped + lowercased to match the normalized form.
 */
const CATEGORY_STOPLIST: ReadonlySet<string> = new Set([
  // Expense categories
  'sueldos', 'sueldo', 'arrendamiento', 'alquiler', 'servicios', 'impuestos',
  'contabilidad', 'administracion', 'administración', 'gastos', 'gasto',
  'combustible', 'gasoil', 'nafta', 'fertilizante', 'fertilizantes',
  'semillas', 'semilla', 'herbicida', 'herbicidas', 'fungicida', 'fungicidas',
  'insecticida', 'insecticidas', 'agroquimico', 'agroquimicos', 'agroquímico', 'agroquímicos',
  'flete', 'fletes', 'mantenimiento', 'reparaciones', 'reparacion', 'reparación',
  'seguros', 'seguro', 'otros', 'varios',
  // Income categories
  'cosecha', 'venta', 'ventas', 'ingreso', 'ingresos', 'arrendamientos',
  // Compound categories (e.g. "labranza", "fumigacion")
  'labranza', 'labranzas', 'fumigacion', 'fumigación', 'fumigaciones',
  'siembra', 'siembras', 'pulverizacion', 'pulverización',
  // Plain currency words
  'pesos', 'peso', 'dolares', 'dólares', 'dolar', 'dólar', 'usd', 'ars',
]);

export function looksLikeCategoryWord(candidate: string): boolean {
  if (!candidate) return false;
  // Normalize: lowercase + strip accents
  const normalized = candidate.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  // Direct match
  if (CATEGORY_STOPLIST.has(normalized)) return true;
  // Match on first token (handles "sueldos del mes" type phrasings)
  const firstToken = normalized.split(/\s+/)[0];
  if (firstToken && CATEGORY_STOPLIST.has(firstToken)) return true;
  return false;
}
