/**
 * Agent output validator.
 *
 * Strips entities the agent inferred without backing in the user's original text.
 * The model is treated as a hint generator; the validator is the source of truth.
 *
 * Validation rules ship incrementally and are gated by individual flags so each
 * one can be toggled without redeploying. The caller (agent.service.ts) loads
 * the flags and passes them via `ValidationOptions`. When all flags are false
 * the function is a passthrough.
 *
 * Pronouns intentionally bypass validation in later phases — a `__last__` value
 * is preserved when the user text has an explicit pronoun ("ahí", "ese lote"),
 * so legitimate multi-turn references keep working.
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
    const dropped = stripCropIfUnsupported(input, ctx.originalText);
    if (dropped) {
      input = { ...input };
      delete input.crop;
      droppedFields.push('crop');
    }
  }

  return { input, droppedFields };
}

/**
 * Returns true if the agent's `crop` value is unsupported by the user's text
 * (i.e., the user never mentioned that crop or any of its known synonyms).
 * Returns false when there is no `crop` to validate, when `crop` is the
 * `__last__` pronoun sentinel (handled separately), or when the text backs it.
 */
function stripCropIfUnsupported(input: Record<string, unknown>, originalText: string): boolean {
  const cropValue = input.crop;
  if (typeof cropValue !== 'string') return false;
  const trimmed = cropValue.trim();
  if (trimmed === '' || trimmed === '__last__') return false;

  const cropFromText = extractCropFromText(originalText);
  if (!cropFromText) return true; // user mentioned no crop at all → strip
  // user mentioned a crop; strip only if the agent's value diverges from it
  return normalizeCanonical(cropFromText) !== normalizeCanonical(trimmed);
}

function normalizeCanonical(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}
