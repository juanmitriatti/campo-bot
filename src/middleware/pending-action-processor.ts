/**
 * Pending action processor — the controller entry point that turns a sequence
 * of multi-turn user messages into a single completed write tool call.
 *
 * Flow:
 *   handler returns sideEffects.setPendingActivity({
 *     command: 'log_fertilization',
 *     data: { event_date: '2026-05-21' },
 *     missing: ['product', 'plot', 'quantity'],
 *     askPrompt: '¿Qué producto, en qué lote y qué cantidad?',
 *   })
 *
 *   controller saves it to pendingActStore + sends askPrompt.
 *
 *   next user message → controller calls processPendingAction(text, pending).
 *   The extractor pulls every slot it can from the text and merges with
 *   pending.data. If all required slots are filled, the command is re-routed
 *   to the handler. If some are still missing, the controller re-asks only
 *   for what's left.
 *
 * The user can ALWAYS escape by:
 *   - sending a clear new financial intent (handled by detectsFinancialIntent
 *     in the caller — this module does not see escape cases)
 *   - typing "cancelar"
 */

import type { PendingActivity } from './pending-activities.js';
import { extractSlots, type ExtractedSlots, type SlotName } from './slot-extractor.js';
import { stripAnswerPrefix } from '../utils/lexicon.js';

/**
 * Commands that START a brand-new write and therefore legitimately interrupt a
 * pending activity (the user pivoted). A pending with missing slots must NOT be
 * escaped just because the reply happens to parse as a READ/query command —
 * "maíz" parses as a crop query, "lote A" as a plot query, "280" as a number —
 * those are ANSWERS to the pending, not pivots. Escaping on them was the cause
 * of the compound-siembra and gasto-plot data loss. Only a real new write (or a
 * financial intent, handled separately) should clear the pending.
 */
const NEW_ACTION_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'add_field', 'add_plot', 'add_plots_batch',
  'sow_crop', 'harvest_crop', 'log_spraying', 'log_fertilization',
  'log_tillage', 'log_irrigation', 'log_rainfall', 'log_observation',
  'log_crop_scouting',
  'log_expense', 'log_income', 'set_budget',
  'add_livestock', 'remove_livestock', 'transfer_livestock', 'adjust_livestock',
  'record_livestock_birth', 'record_livestock_death',
  'log_health_event', 'log_repro_event', 'log_weighing', 'log_tacto',
  'add_stock', 'create_warehouse',
]);

/**
 * True when a parsed command should interrupt an open pending (a genuine new
 * write), as opposed to a read/query that is really the pending's answer.
 */
export function isNewActionInterrupt(cmd: { command?: string } | null | undefined): boolean {
  return !!cmd?.command && NEW_ACTION_WRITE_COMMANDS.has(cmd.command);
}

export interface PendingProcessResult {
  /** Updated pending state (merged). null = pending fully satisfied → caller should re-route the command. */
  next: PendingActivity | null;
  /** What was newly extracted from THIS message (for debug + the bot's "ok, anoté X" line). */
  extracted: ExtractedSlots;
  /** Human-readable list of slots still missing after merge. Empty when ready to execute. */
  stillMissing: SlotName[];
  /**
   * Fully merged data — includes pending.data + extracted slots + any
   * overwrites (currency, etc.) applied by the processor. Callers should
   * use this directly when re-routing the command rather than re-merging
   * from the (now-stale) pending.data. Without this, a "later turn
   * overrides earlier default" — like the user clarifying "100 mil
   * dólares" after the agent defaulted currency to ARS — is silently
   * lost because the controller's own merge applies no-overwrite to
   * pending.data again.
   */
  finalData: Record<string, unknown>;
}

/**
 * Merge a new user message into the pending action.
 *
 * @param text Raw user message.
 * @param pending Current pending state with `data` (already-filled) and `missing` (required slots).
 * @returns Updated pending + what changed.
 */
export function processPendingAction(text: string, pending: PendingActivity): PendingProcessResult {
  const slotCtx = deriveSlotContext(pending.command);
  const extracted = extractSlots(text, slotCtx);

  // Single-slot fallback: when only one slot is missing and the SlotExtractor
  // couldn't pull anything (or pulled the wrong thing), treat a short message
  // as the answer to that slot directly. E.g. pending.missing=['product']
  // (asked "¿qué vacuna?") and user replies "aftosa" — the regex needs "con
  // aftosa" to match. This fallback handles bare-word answers.
  // CRITICAL: slot-aware validation. Numeric slots (quantity/amount/unit_price/
  // count/hectares) must receive a number — otherwise a date like "el 15 de
  // mayo" gets stored as quantity and crashes downstream with "invalid input
  // syntax for type numeric". Also bail when the user clearly types a
  // correction pattern instead of a slot value.
  const missing = pending.missing ?? [];
  const NUMERIC_SLOTS = new Set<SlotName>(['quantity' as SlotName, 'amount' as SlotName, 'unit_price' as SlotName, 'count' as SlotName, 'hectares' as SlotName]);
  const CORRECTION_PREFIX = /^(no,?|perd[oó]n|en realidad|quise decir|mejor|cambio)\b/i;
  // Compute the slots that are STILL empty — a pending may list several required
  // slots ('product','plot','quantity') while data already holds most of them, so
  // effectively only ONE is missing. Using this (not raw missing.length) lets the
  // plot/field strip fire even when the pending carried extra already-filled slots
  // (#15: "no, en Sur" on a spray that already had product+quantity).
  const pdata = (pending.data ?? {}) as Record<string, unknown>;

  const stillEmpty = missing.filter((s) => {
    if (extracted[s as SlotName] != null) return false;
    return slotToCmdKeys(s as SlotName).every((k) => pdata[k] == null);
  });
  if (stillEmpty.length === 1) {
    const slot = stillEmpty[0] as SlotName;
    const cleaned = text.trim();
    const shapeOk = cleaned.length > 0 && cleaned.length <= 60
      && /^[A-Za-záéíóúñ0-9][\wáéíóúñ\s.,-]*$/i.test(cleaned);
    if (shapeOk && (slot === 'plot' || slot === 'field')) {
      // Plot/field answers commonly carry a correction prefix and/or "en":
      // "no, en Sur", "en el Norte", "mejor el lote A". Strip them and use the
      // remainder as the name — otherwise the CORRECTION_PREFIX bail drops the
      // whole activity (P1-A / #15).
      const stripped = stripAnswerPrefix(cleaned);
      if (stripped) {
        (extracted as Record<string, unknown>)[slot] = stripped;
        // "en Este" also makes the field-extractor fire (field="Este") — a false
        // positive for a PLOT answer. Drop it so the re-route doesn't look for a
        // nonexistent FIELD named after the plot (#15: spray dropped on "no, en Este").
        if (slot === 'plot') delete (extracted as Record<string, unknown>).field;
      }
    } else if (shapeOk && !CORRECTION_PREFIX.test(cleaned)) {
      if (NUMERIC_SLOTS.has(slot)) {
        const numMatch = cleaned.match(/^[0-9]+(?:[.,][0-9]+)?$/);
        if (numMatch) {
          (extracted as Record<string, unknown>)[slot] = parseFloat(cleaned.replace(',', '.'));
        }
        // numeric slot but non-numeric text → leave unfilled, controller will re-ask
      } else {
        (extracted as Record<string, unknown>)[slot] = cleaned;
      }
    }
  }

  // Merge extracted into pending.data WITHOUT overwriting slots already filled
  // — unless the new value is for a slot in `missing` (then the merge IS the
  // whole point). The "no overwrite" rule prevents an extractor from clobbering
  // a confirmed value on a later turn (e.g. the user already said "soja", the
  // next turn mentions "trigo en la región" — keep soja).
  // NOTE: `missing` was already declared above for the single-slot fallback;
  // reuse it here (previously this line re-declared it as `const missing` and
  // tsx/esbuild silently bailed on the transform — breaking every multi-turn
  // pending answer with a 500 error).
  const data = { ...pending.data };
  const filledByThisTurn: SlotName[] = [];

  for (const slot of missing) {
    const key = slot as SlotName;
    const value = (extracted as Record<string, unknown>)[key];
    if (value == null) continue;
    // Map slot name → cmd field. Most are 1:1, a few translate.
    const targetKeys = slotToCmdKeys(key);
    for (const target of targetKeys) {
      if (data[target] == null) data[target] = value;
    }
    filledByThisTurn.push(key);
  }

  // ALSO merge "adjacent" extracted slots that aren't in `missing` but are
  // commonly needed to compute it. Example: pending.missing=['amount'] for a
  // partial income, user replies "550 USD por tonelada" → extractor pulls
  // unit_price+currency (not amount). If we don't merge these, the cross-fill
  // below (qty*unit_price → amount) has nothing to work with. We still
  // respect the no-overwrite rule.
  // Adjacent slots that we also merge if extracted, even when not in `missing`.
  // This handles cases like a partial income with missing=['amount'] where the
  // user replies "Lote a2" — without 'plot' here, the plot would be extracted
  // but silently dropped (user 4 incident, 2026-05-28).
  const ADJACENT_SLOTS: SlotName[] = ['unit_price', 'quantity', 'unit', 'currency', 'amount', 'plot', 'field', 'category', 'crop'];
  // Currency CAN overwrite — the agent often defaults to ARS on a partial
  // intent ("10tn de soja"), and the user clarifies later ("100 mil dolares").
  // Without an overwrite the saved record has the wrong currency.
  const OVERWRITABLE: ReadonlySet<SlotName> = new Set(['currency' as SlotName]);
  for (const slot of ADJACENT_SLOTS) {
    if (missing.includes(slot)) continue; // already handled above
    const value = (extracted as Record<string, unknown>)[slot];
    if (value == null) continue;
    const targetKeys = slotToCmdKeys(slot);
    for (const target of targetKeys) {
      if (data[target] == null || OVERWRITABLE.has(slot)) data[target] = value;
    }
  }

  const stillMissing = missing.filter((s) => !filledByThisTurn.includes(s as SlotName)) as SlotName[];

  // Special case: when amount + quantity + unit_price are all in flight, the
  // handler may treat unit_price as the missing slot but the user provides
  // amount directly. Cross-fill.
  if (stillMissing.includes('amount' as SlotName) && data.amount != null) {
    stillMissing.splice(stillMissing.indexOf('amount' as SlotName), 1);
  }

  // Cross-fill #2 — CRITICAL: when a partial financial action queued with
  // `missing: ['amount']` (the income_partial / expense_partial path) gets a
  // reply like "550 USD por tonelada", the slot-extractor pulls unit_price
  // but NOT amount. If the partial already had `quantity` (from the original
  // compound message), we can compute amount = quantity * unit_price right
  // here and treat 'amount' as filled. Without this, the bot saves `$0` for
  // the partial then re-asks plot — silent data corruption seen in QA suite
  // qa-broad-coverage-30 tests A04 + E22.
  if (stillMissing.includes('amount' as SlotName)
      && typeof data.quantity === 'number' && data.quantity > 0
      && typeof data.unit_price === 'number' && data.unit_price > 0) {
    data.amount = Math.round(data.quantity * data.unit_price * 100) / 100;
    stillMissing.splice(stillMissing.indexOf('amount' as SlotName), 1);
  }

  if (stillMissing.length === 0) {
    return { next: null, extracted, stillMissing: [], finalData: data };
  }

  return {
    next: {
      command: pending.command,
      data,
      timestamp: Date.now(),
      missing: stillMissing,
      askPrompt: buildAskPromptForMissing(stillMissing, pending.askPrompt),
      // Preserve the serial queue across a still-missing re-ask. Without this, a
      // pivot/garbage answer that couldn't fill the slot re-asked but DROPPED the
      // queued siblings → the rest of a multi-item compound was silently lost (N1).
      ...(pending.nextInQueue && pending.nextInQueue.length > 0 ? { nextInQueue: pending.nextInQueue } : {}),
    },
    extracted,
    stillMissing,
    finalData: data,
  };
}

function deriveSlotContext(command: string): { type?: 'expense' | 'income' | 'activity' } {
  if (command === 'log_expense') return { type: 'expense' };
  if (command === 'log_income') return { type: 'income' };
  return { type: 'activity' };
}

/**
 * Map a generic slot name to the cmd-object field name(s) the handler reads.
 * Most cmd shapes use the same camelCase but a few have aliases (plot vs
 * plotName, field vs fieldName).
 */
function slotToCmdKeys(slot: SlotName): string[] {
  switch (slot) {
    case 'plot': return ['plot', 'plotName'];
    case 'field': return ['field', 'fieldName'];
    case 'unit_price': return ['unit_price', 'unitPrice'];
    case 'hectares': return ['hectares'];
    case 'currency': return ['currency'];
    default: return [slot];
  }
}

const SLOT_LABEL: Record<SlotName, string> = {
  amount: 'el monto',
  category: 'la categoría',
  plot: 'el lote',
  field: 'el campo',
  crop: 'el cultivo',
  quantity: 'la cantidad',
  unit: 'la unidad',
  unit_price: 'el precio unitario',
  product: 'el producto',
  currency: 'la moneda',
  count: 'la cantidad de animales',
  hectares: 'las hectáreas',
};

function buildAskPromptForMissing(missing: SlotName[], fallback?: string): string {
  if (missing.length === 0) return fallback ?? '';
  if (missing.length === 1) return `Me falta ${SLOT_LABEL[missing[0]]}. ¿Me lo decís?`;
  const last = SLOT_LABEL[missing[missing.length - 1]];
  const rest = missing.slice(0, -1).map((s) => SLOT_LABEL[s]).join(', ');
  return `Me faltan ${rest} y ${last}. ¿Me los pasás?`;
}
