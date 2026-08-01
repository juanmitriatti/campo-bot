/**
 * Agent output validator.
 *
 * Strips entities the agent inferred without backing in the user's original text.
 * The model is treated as a hint generator; the validator is the source of truth.
 *
 * Validation rules ship incrementally and are gated by individual flags so each
 * one can be toggled without redeploying. The caller (intent-classifier.ts)
 * loads the flags and passes them via `ValidationOptions`. When all flags are
 * false the function is a passthrough.
 *
 * Pronouns intentionally bypass strict matching — `__last__` is preserved when
 * the user text has an explicit pronoun ("ahí", "ese lote"), so legitimate
 * multi-turn references keep working.
 */

import { extractAllCropsFromText } from '../utils/crops.js';

export interface ValidationContext {
  toolName: string;
  input: Record<string, unknown>;
  originalText: string;
}

export interface ValidationOptions {
  /** Strip `crop` when the user's text doesn't mention any known crop. */
  validateCrop?: boolean;
  /** Strip `plot`/`field` when not in user text or not a valid pronoun. */
  validatePlotField?: boolean;
  /** Canonical plot names owned/shared with the user (for plot validation). */
  userPlots?: string[];
  /** Canonical field names owned/shared with the user (for field validation). */
  userFields?: string[];
}

export interface ValidationResult {
  input: Record<string, unknown>;
  droppedFields: string[];
}

/** Tools where `crop` should reflect a real cultivo named by the user. */
const CROP_AWARE_TOOLS = new Set([
  'sow_crop',
  'harvest_crop',
  'log_spraying',
  'log_fertilization',
  'log_tillage',
  'log_irrigation',
  'log_observation',
  'log_crop_scouting',
  'active_crop',
  'campaign_stats',
  'compare_campaigns',
  'query_plot_history',
]);

/**
 * Tools that CREATE or RENAME entities — the plot/field name in their input
 * may not exist yet, so plot/field validation must skip them. Validating these
 * would break add_plot ("agregar lote tommy") and rename_field flows.
 */
const ENTITY_CREATION_TOOLS = new Set([
  'add_field',
  'add_plot',
  'add_plots_batch',
  'rename_field',
  'rename_plot',
  'delete_field',
  'delete_plot',
  'restore_plot',
  'restore_field',
  'set_field_city',
  'share_field',
  'accept_invite',
  'remove_field_member',
  'list_field_members',
  'list_fields',
  'create_warehouse',
  'create_feedlot',
  'create_corral',
  'rename_corral',
  'delete_corral',
]);

// Normalización canónica compartida (entity-matcher) — la MISMA que usan los
// lookups SQL de lotes/campos. Si el validador normaliza distinto que el
// resolver, un nombre puede pasar la validación y no resolver (o viceversa).
import { normalizeEntityName as normalize } from '../utils/entity-matcher.js';

/**
 * Pronoun phrases that legitimately reference the previous plot/field.
 * Mirrors the same set declared in the agent prompt. Patterns run against
 * accent-stripped + lowercased text, so accents don't need handling here.
 */
const PRONOUN_PATTERNS: RegExp[] = [
  /\bahi\b/,
  /\balla\b/,
  /\balli\b/,
  // Sincronizado con utils/pronoun-expander.ts: ese/este/aquel/aquella + lote/campo/potrero/parcela
  /\b(ese|este|aquel|aquella|esa)\s+(lote|campo|potrero|parcela|mismo)\b/,
  /\besa\s+misma\b/,
  /\bel\s+(mismo|otro|anterior|de\s+(antes|recien|hoy))\b/,
  /\bla\s+(misma|de\s+antes)\b/,
  /\bahi\s+(adentro|mismo)\b/,
  /\ben\s+ese\b/,
  /\bde\s+nuevo\b/,
];

function hasPronounReference(text: string): boolean {
  const norm = normalize(text);
  return PRONOUN_PATTERNS.some(re => re.test(norm));
}

/**
 * Returns the input with agent-inferred fields stripped when the user's text
 * doesn't back them. Stable signature: callers pass the same context every
 * call; subsequent phases extend `ValidationOptions` without breaking sites.
 */
export function validateToolCall(
  ctx: ValidationContext,
  options: ValidationOptions = {},
): ValidationResult {
  let { input } = ctx;
  const droppedFields: string[] = [];

  if (options.validateCrop && CROP_AWARE_TOOLS.has(ctx.toolName)) {
    if (shouldStripCrop(input, ctx.originalText)) {
      input = { ...input };
      delete input.crop;
      droppedFields.push('crop');
    }
  }

  if (options.validatePlotField && !ENTITY_CREATION_TOOLS.has(ctx.toolName)) {
    if (shouldStripPlot(input, ctx, options)) {
      if (input === ctx.input) input = { ...input };
      delete input.plot;
      droppedFields.push('plot');
    }
    if (shouldStripField(input, ctx, options)) {
      if (input === ctx.input) input = { ...input };
      delete input.field;
      droppedFields.push('field');
    }
  }

  return { input, droppedFields };
}

function shouldStripCrop(input: Record<string, unknown>, originalText: string): boolean {
  const cropValue = input.crop;
  if (typeof cropValue !== 'string') return false;
  const trimmed = cropValue.trim();
  if (trimmed === '' || trimmed === '__last__') return false;

  // TODOS los cultivos del texto, no solo el primero: en compounds multi-cultivo
  // ("sembré soja en Norte y maíz en Sur") la versión singular validaba el
  // segundo tool contra "soja" y descartaba "maíz" como alucinación.
  const cropsInText = extractAllCropsFromText(originalText);
  if (cropsInText.length === 0) return true;
  const normTrimmed = normalize(trimmed);
  return !cropsInText.some(c => normalize(c) === normTrimmed);
}

/**
 * Strip `plot` when the agent's value isn't grounded in the user's text:
 *  - `__last__` requires an explicit pronoun in the text.
 *  - Any other value must be one of the user's known plots AND either
 *    (a) appear as a whole word in the text, OR (b) the text contains a
 *    deictic/pronoun reference ("ahí", "el otro", "el mismo", "ese lote"...).
 *
 * Rationale (SOLUCIÓN GENERALIZADA, Jun 2026): el agente resuelve plots desde
 * el contexto cuando el usuario usa un deíctico ("el otro lote", "ahí también").
 * El pronoun-expander cubre frases conocidas, pero por audio/variantes siempre
 * se le escapan algunas; cuando eso pasa, el agente igual resuelve bien por
 * contexto pero ESTE validador lo dropeaba como alucinación → el dato caía en
 * el lote equivocado (visto live: "en el otro lote sembré maíz" → maíz a Norte).
 * Regla: si el lote es REAL del usuario y hay CUALQUIER deíctico de lugar en el
 * texto, es resolución de contexto legítima, no invención → no dropear. Solo se
 * dropea un lote conocido cuando NO está en el texto Y NO hay deíctico (ahí sí
 * huele a invención pura: "gasté en sueldos" + plot fantasma).
 * Si no tenemos la lista de lotes, no podemos validar → no strip.
 */
function shouldStripPlot(
  input: Record<string, unknown>,
  ctx: ValidationContext,
  options: ValidationOptions,
): boolean {
  const plotValue = input.plot;
  if (typeof plotValue !== 'string') return false;
  const trimmed = plotValue.trim();
  if (trimmed === '') return false;

  if (trimmed === '__last__') {
    return !hasPronounReference(ctx.originalText);
  }

  if (!options.userPlots || options.userPlots.length === 0) return false;
  const isKnown = options.userPlots.some(n => normalize(n) === normalize(trimmed));
  if (!isKnown) return true; // no es un lote del usuario → invención → dropear
  if (mentionedInText(trimmed, ctx.originalText, options.userPlots)) return false;
  // Cuantificador COLECTIVO ("en cada lote", "todos los lotes", "ambos"): el
  // usuario referenció todos sus lotes de una — el agente distribuyó bien y
  // strippear los nombres colapsaba las N tools en una por el dedup del
  // compound (QA agentes Ago 2026: "murieron 5 vacas en cada lote" → 1 baja).
  if (hasCollectiveReference(ctx.originalText)) return false;
  // Lote real pero no literal en el texto: aceptar si hay deíctico (contexto).
  return !hasPronounReference(ctx.originalText);
}

function shouldStripField(
  input: Record<string, unknown>,
  ctx: ValidationContext,
  options: ValidationOptions,
): boolean {
  const fieldValue = input.field;
  if (typeof fieldValue !== 'string') return false;
  const trimmed = fieldValue.trim();
  if (trimmed === '') return false;

  if (trimmed === '__last__') {
    return !hasPronounReference(ctx.originalText);
  }

  if (!options.userFields || options.userFields.length === 0) return false;
  // Misma regla generalizada que el plot: campo real + deíctico = contexto, no
  // invención. Cubre "el otro lote" donde el agente infiere también el campo.
  const isKnown = options.userFields.some(n => normalize(n) === normalize(trimmed));
  if (!isKnown) return true;
  if (mentionedInText(trimmed, ctx.originalText, options.userFields)) return false;
  if (hasCollectiveReference(ctx.originalText)) return false;
  return !hasPronounReference(ctx.originalText);
}

/**
 * Cuantificador colectivo de ubicación: "en cada lote", "en todos los lotes",
 * "en ambos (lotes)", "en los dos potreros". Es una referencia LEGÍTIMA a todos
 * los lotes/campos del usuario — el agente que distribuye la acción nombrando
 * cada lote NO está alucinando.
 */
export function hasCollectiveReference(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(?:en\s+)?(?:cada|todos?\s+l[oa]s|ambos|los\s+dos|las\s+dos)\s+(?:lotes?|potreros?|corrales?|campos?)\b/i.test(text);
}

/**
 * Returns true if `value` is one of the user's known names AND appears in the
 * original text (accent-insensitive, case-insensitive).
 *
 * Acepta dos formas:
 *  1. El nombre COMPLETO como palabra entera ("Lote Norte Grande" en el texto).
 *  2. Algún token significativo del nombre (≥3 letras o numérico) como palabra
 *     entera — el productor dice "fumigué el norte" y el agente resuelve el
 *     nombre canónico "Lote Norte Grande" desde su contexto; exigir el nombre
 *     completo descartaba esa resolución legítima. Tokens genéricos ("lote",
 *     "campo", "potrero", "el", "la") no cuentan.
 * Word-boundary check prevents false positives like "1B" matching "1B12".
 */
const GENERIC_NAME_TOKENS = new Set(['lote', 'campo', 'potrero', 'parcela', 'chacra', 'el', 'la', 'los', 'las', 'de', 'del', 'don', 'dona', 'san', 'santa']);

function wholeWordInText(token: string, normText: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu');
  return re.test(normText);
}

function mentionedInText(value: string, originalText: string, knownNames: string[]): boolean {
  const normValue = normalize(value);
  const known = knownNames.find(n => normalize(n) === normValue);
  if (!known) return false;

  const normText = normalize(originalText);
  if (wholeWordInText(normValue, normText)) return true;

  // Matching parcial por token significativo del nombre canónico.
  const tokens = normValue.split(/\s+/).filter(t =>
    !GENERIC_NAME_TOKENS.has(t) && (/\d/.test(t) || t.length >= 3),
  );
  return tokens.some(t => wholeWordInText(t, normText));
}
