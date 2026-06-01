/**
 * Detect whether the user's message explicitly references a plot — either by
 * naming one or by using a pronoun that points to a recent one ("ahí mismo",
 * "ese lote", "el mismo", "el de antes", etc.).
 *
 * Used by handlers to distinguish:
 *   - "pagué sueldos $300k"                   → no plot intent (auto-strip OK)
 *   - "pagué sueldos $300k en el lote Verde"  → explicit intent (DO NOT strip)
 *   - "pagué sueldos $300k ahí mismo"         → pronoun intent (DO NOT strip)
 *
 * The FIELD_LEVEL_CATEGORIES rule in financial.handler.ts was originally
 * added to prevent silent assignment of corporate-overhead expenses
 * ("sueldos", "arrendamiento", etc.) to the user's single lote when no plot
 * was mentioned. But the rule was too aggressive: it stripped plotId even
 * when the user EXPLICITLY mentioned a plot (via name or pronoun resolved
 * through context_stack). This helper fixes that — handlers consult it
 * before stripping.
 */

/**
 * Patterns that signal the user explicitly referenced a plot. Mirrors the
 * pronoun-expander patterns plus explicit "lote <name>" / "potrero <name>"
 * mentions and plot-attachment prepositions ("en", "al", "del").
 */
const PLOT_INTENT_PATTERNS: ReadonlyArray<RegExp> = [
  // Plot pronouns (must match pronoun-expander)
  /\b(?:ah[ií]|all[íi]|all[áa])\s+mismo\b/i,
  /\b(?:el\s+)?mismo\s+(?:lote|campo|potrero)\b/i,
  /\bel\s+mismo\b/i,
  /\b(?:ese|este|aquel|aquella?|esa)\s+(?:lote|campo|potrero|parcela)\b/i,
  /\bel\s+(?:de\s+(?:antes|reci[eé]n|hoy)|anterior)\b/i,
  /\b(?:en|a|del?)\s+ah[ií]\b/i,
  /\b(?:en|a|del?)\s+all[íi]\b/i,
  // Explicit plot mentions — "en lote X", "al lote X", "del lote X", etc.
  /\b(?:en|al|del?|para\s+(?:el\s+)?)\s*(?:el\s+|la\s+)?(?:lote|potrero|parcela|cuadr[oa])\s+[\p{L}\p{N}]/iu,
  /\b(?:lote|potrero|parcela|cuadr[oa])\s+[\p{L}\p{N}][\p{L}\p{N}\s\-]*$/iu,
];

/**
 * Returns true when the text explicitly references a plot (by name or
 * pronoun). Used by handlers to decide whether to honor a context-resolved
 * plot vs strip it as auto-assigned.
 *
 * Conservative by design: when in doubt, returns true. False positives
 * (saying yes when user didn't really mean it) preserve plot assignment
 * which is recoverable via correction. False negatives (saying no when
 * user did mean it) cause silent data loss to field-level, which is the
 * bug we're fixing.
 */
export function userExplicitlyReferencedPlot(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return PLOT_INTENT_PATTERNS.some(re => re.test(normalized));
}

/**
 * Flows whose current step asks the user for a plot ("¿En qué lote?"). When one
 * of these is active and the user answers with a plot reference ("lote A",
 * "ahí mismo"), that reply is the ANSWER — not a command interruption.
 */
const PLOT_COLLECTING_FLOWS: ReadonlySet<string> = new Set([
  'expense_flow', 'income_flow', 'activity_flow', 'rainfall_flow',
]);

/**
 * True when an active plot-collecting flow should consume `text` as its plot
 * answer instead of letting it cancel the flow. This closes the #1 data-loss
 * bug: "gasté 120 mil en X" → "¿en qué lote?" → "lote A" used to parse as a
 * plot QUERY command, cancel the flow, hit the classifier as a query, and drop
 * the expense. Now the plot-ish reply stays inside the flow and the record is
 * saved. General by design — any plot-collecting flow inherits it.
 */
export function isPlotAnswerToFlow(flowState: string | null | undefined, text: string): boolean {
  if (!flowState || !PLOT_COLLECTING_FLOWS.has(flowState)) return false;
  return userExplicitlyReferencedPlot(text);
}
