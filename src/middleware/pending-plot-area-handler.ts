import type { PendingPlotAreaStore, PendingPlotArea } from './pending-plot-area.js';
import type { FinancialService } from '../domain/financial/financial.service.js';

export interface PendingPlotAreaResult {
  messages: string[];
  handled: boolean; // true = message consumed (don't fall through to pipeline)
}

export function parseHectares(text: string): number | null {
  // Decimal comma → dot, then pull every number out. A bare parseFloat takes the
  // FIRST token, which breaks mid-message corrections like "40, ah no eran 60"
  // (the user means 60). When a correction cue is present, prefer the LAST number.
  const cleaned = text.replace(/,/g, '.');
  const nums = cleaned.match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  const hasCorrection = /\b(no|perd[oó]n|en\s+realidad|eran?|mejor\s+dicho|quise\s+decir|digo)\b/i.test(text);
  const pick = hasCorrection ? nums[nums.length - 1] : nums[0];
  const val = parseFloat(pick);
  if (isNaN(val) || val <= 0 || val >= 100000) return null;
  return val;
}

function isCancelIntent(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return ['cancelar', 'cancel', 'salir', 'no', 'parar', 'basta', 'chau', 'terminar'].includes(lower);
}

function buildPrompt(item: PendingPlotArea, position: number, total: number): string {
  const counter = total > 1 ? ` (${position} de ${total})` : '';
  return `📐 ¿Cuántas hectáreas tiene *${item.plotName}*?${counter}`;
}

/**
 * Shared handler for pending plot area assignment.
 * Used by all 3 controllers (WhatsApp, Telegram, test-bot).
 *
 * Returns { handled: true } when the message was consumed (valid hectares, cancel, or re-prompt).
 */
export async function handlePendingPlotArea(
  text: string,
  phone: string,
  store: PendingPlotAreaStore,
  financialService: FinancialService,
): Promise<PendingPlotAreaResult> {
  const pending = store.get(phone);
  if (!pending) {
    return { messages: [], handled: false };
  }

  const total = store.remaining(phone);

  // Cancel → clear entire queue
  if (isCancelIntent(text)) {
    store.clear(phone);
    return {
      messages: ['👍 Podés asignar las hectáreas después.'],
      handled: true,
    };
  }

  // Try to parse hectares
  const hectares = parseHectares(text);

  if (hectares !== null) {
    // Valid → save area
    await financialService.setPlotArea(pending.plotId, hectares);
    const confirmMsg = `📍 Lote *${pending.plotName}*: superficie actualizada a *${hectares} ha*`;

    // Dequeue and check for next
    const next = store.dequeueFirst(phone);
    if (next) {
      const newTotal = store.remaining(phone);
      const position = total - newTotal;
      const nextPrompt = buildPrompt(next, position, total - 1 + position);
      return {
        messages: [confirmMsg, nextPrompt],
        handled: true,
      };
    }

    // Queue exhausted
    return {
      messages: [confirmMsg],
      handled: true,
    };
  }

  // Invalid input → re-prompt (blocking, do NOT fall through)
  return {
    messages: [`Ingresá un número válido de hectáreas para *${pending.plotName}*.\nEj: *150* o *150 ha*\n\nEscribí *cancelar* para omitir.`],
    handled: true,
  };
}

/**
 * Process setPendingPlotArea / setPendingPlotAreaQueue sideEffects from a HandlerResponse.
 * Stores in the queue and returns a prompt message to append (or null).
 */
export function storePlotAreaSideEffects(
  phone: string,
  store: PendingPlotAreaStore,
  sideEffects: {
    setPendingPlotArea?: { plotId: number; plotName: string; fieldName: string };
    setPendingPlotAreaQueue?: Array<{ plotId: number; plotName: string; fieldName: string }>;
  } | undefined,
): string | null {
  if (!sideEffects) return null;

  const now = Date.now();

  if (sideEffects.setPendingPlotAreaQueue && sideEffects.setPendingPlotAreaQueue.length > 0) {
    const items = sideEffects.setPendingPlotAreaQueue.map(p => ({
      plotId: p.plotId, plotName: p.plotName, fieldName: p.fieldName, timestamp: now,
    }));
    store.setQueue(phone, items);
    const total = items.length;
    const counter = total > 1 ? ` (1 de ${total})` : '';
    return `📐 ¿Cuántas hectáreas tiene *${items[0].plotName}*?${counter}`;
  }

  if (sideEffects.setPendingPlotArea) {
    const pa = sideEffects.setPendingPlotArea;
    store.set(phone, { plotId: pa.plotId, plotName: pa.plotName, fieldName: pa.fieldName, timestamp: now });
    return `📐 ¿Cuántas hectáreas tiene *${pa.plotName}*?`;
  }

  return null;
}
