/**
 * Agent output validator.
 *
 * Strips entities the agent inferred without backing in the user's original text.
 * The model is treated as a hint generator; the validator is the source of truth.
 *
 * Validation rules are added incrementally and gated by the
 * `AGENT_OUTPUT_VALIDATION_ENABLED` setting so each rule can be flipped on/off
 * without redeploying.
 *
 * Phase 1 (this file): passthrough skeleton. No actual stripping yet.
 *  - Lets us wire the validator into agent-response-mapper.ts without behavior change
 *  - Subsequent phases register `FieldValidator`s here (crop, plot, field, ...)
 *
 * Pronouns intentionally bypass validation in later phases — a `__last__` value is
 * preserved when the user text has an explicit pronoun ("ahí", "ese lote", etc.),
 * so legitimate multi-turn references keep working.
 */

export interface ValidationContext {
  toolName: string;
  input: Record<string, unknown>;
  originalText: string;
}

export interface ValidationResult {
  input: Record<string, unknown>;
  droppedFields: string[];
}

/**
 * Returns the input unchanged plus an empty `droppedFields` list. Subsequent
 * phases replace the implementation with real per-field validation. Keeping
 * the signature stable lets the call sites in agent-response-mapper.ts be wired
 * once and never touched again.
 */
export function validateToolCall(ctx: ValidationContext): ValidationResult {
  return {
    input: ctx.input,
    droppedFields: [],
  };
}
