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

import { extractCropFromText } from '../utils/crops.js';

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

const COMBINING_MARKS = /[̀-ͯ]/g;

function normalize(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().trim();
}

/**
 * Pronoun phrases that legitimately reference the previous plot/field.
 * Mirrors the same set declared in the agent prompt. Patterns run against
 * accent-stripped + lowercased text, so accents don't need handling here.
 */
const PRONOUN_PATTERNS: RegExp[] = [
  /\bahi\b/,
  /\balla\b/,
  /\balli\b/,
  /\bese\s+(lote|campo|mismo)\b/,
  /\besa\s+misma\b/,
  /\bel\s+(mismo|de\s+antes)\b/,
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

  const cropFromText = extractCropFromText(originalText);
  if (!cropFromText) return true;
  return normalize(cropFromText) !== normalize(trimmed);
}

/**
 * Strip `plot` when the agent's value isn't grounded in the user's text:
 *  - `__last__` requires an explicit pronoun in the text.
 *  - Any other value must (a) be one of the user's known plots, AND (b)
 *    appear as a whole word in the user's text.
 * If we don't have the user's plot list, we can't validate safely → no strip.
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
  return !mentionedInText(trimmed, ctx.originalText, options.userPlots);
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
  return !mentionedInText(trimmed, ctx.originalText, options.userFields);
}

/**
 * Returns true if `value` is one of the user's known names AND appears as a
 * whole word in the original text (accent-insensitive, case-insensitive).
 * Word-boundary check prevents false positives like "1B" matching "1B12".
 */
function mentionedInText(value: string, originalText: string, knownNames: string[]): boolean {
  const normValue = normalize(value);
  const known = knownNames.find(n => normalize(n) === normValue);
  if (!known) return false;

  const escaped = normValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu');
  return re.test(normalize(originalText));
}
