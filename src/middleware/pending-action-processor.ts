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

export interface PendingProcessResult {
  /** Updated pending state (merged). null = pending fully satisfied → caller should re-route the command. */
  next: PendingActivity | null;
  /** What was newly extracted from THIS message (for debug + the bot's "ok, anoté X" line). */
  extracted: ExtractedSlots;
  /** Human-readable list of slots still missing after merge. Empty when ready to execute. */
  stillMissing: SlotName[];
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

  // Merge extracted into pending.data WITHOUT overwriting slots already filled
  // — unless the new value is for a slot in `missing` (then the merge IS the
  // whole point). The "no overwrite" rule prevents an extractor from clobbering
  // a confirmed value on a later turn (e.g. the user already said "soja", the
  // next turn mentions "trigo en la región" — keep soja).
  const data = { ...pending.data };
  const missing = pending.missing ?? [];
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

  const stillMissing = missing.filter((s) => !filledByThisTurn.includes(s as SlotName)) as SlotName[];

  // Special case: when amount + quantity + unit_price are all in flight, the
  // handler may treat unit_price as the missing slot but the user provides
  // amount directly. Cross-fill.
  if (stillMissing.includes('amount' as SlotName) && data.amount != null) {
    stillMissing.splice(stillMissing.indexOf('amount' as SlotName), 1);
  }

  if (stillMissing.length === 0) {
    return { next: null, extracted, stillMissing: [] };
  }

  return {
    next: {
      command: pending.command,
      data,
      timestamp: Date.now(),
      missing: stillMissing,
      askPrompt: buildAskPromptForMissing(stillMissing, pending.askPrompt),
    },
    extracted,
    stillMissing,
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
