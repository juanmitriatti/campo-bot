/**
 * Detect whether a user message carries a "context signal" — a hint that
 * the bot should INHERIT a recent plot/field from conversation_state
 * instead of asking the user.
 *
 * Used by handlers (handleExpense / handleIncome / ...) to decide whether
 * to fall back to `_resolveFromConversationState` or surface a plot
 * picker. The default (May 28 audit) is CONSERVATIVE: when no signal is
 * present, the user explicitly told us nothing about the plot, so
 * silently inheriting risks asking the user to confirm a save against
 * the WRONG plot — see user 30, 2026-05-28 ("Gaste 1 peso en girasoles"
 * → silently saved against Lote 3 because that was the last conversation
 * context).
 *
 * Signals that count:
 *   1. Pronoun expansion ran (text contains "en lote X" / "en el lote X"
 *      after the pronoun-expander rewrote "ahí mismo" → "en lote X").
 *      Detected by literal "lote" / "potrero" / "parcela" in the text.
 *   2. Continuation starter — "y", "también", "además", "después", "luego"
 *      at the start of the message. Signals "continuing the previous
 *      thought, same context".
 *   3. Explicit plot pronoun ("ahí", "allí", "ese lote", "el mismo", etc.)
 *      Already expanded earlier in the pipeline, but kept here defensively
 *      in case the expansion didn't fire for some reason.
 *
 * Non-signals (DO NOT inherit context):
 *   - Plain expense/income statements with no plot reference and no
 *     continuation marker ("Gaste 1 peso en girasoles", "compré semillas",
 *     "anoté un ingreso de 50k").
 *   - Long messages (>120 chars) — assume the user gave full context
 *     somewhere in the text; if no plot was mentioned, ask.
 */

const PLOT_KEYWORDS = /\b(lote|potrero|parcela|cuadr[oa])\s+[\p{L}\p{N}]/iu;
const CONTINUATION_STARTERS = /^\s*(?:y\b|tambi[eé]n\b|adem[aá]s\b|despu[eé]s\b|luego\b|otro[s]?\b|otra[s]?\b|m[aá]s\b)/i;
const EXPLICIT_PRONOUNS = /\b(?:ah[ií]|all[íi]|all[áa])\s+mismo\b|\b(?:el\s+)?mismo\s+(?:lote|campo)\b|\b(?:ese|este|aquel|esa)\s+(?:lote|campo|potrero|parcela)\b|\bel\s+mismo\b|\bel\s+(?:de\s+(?:antes|reci[eé]n|hoy)|anterior)\b/i;

export function hasPlotContextSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  if (text.length > 120) return false; // long messages = assume full context given
  if (PLOT_KEYWORDS.test(text)) return true;
  if (CONTINUATION_STARTERS.test(text)) return true;
  if (EXPLICIT_PRONOUNS.test(text)) return true;
  return false;
}
