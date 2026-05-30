import { extractCategoryCorrection, extractAmountCorrection } from './conversation-engine.js';
import { detectarCategoria, detectarCategoriaIngreso } from '../utils/parser.js';
import { formatMoney } from '../utils/format-money.js';

export interface PendingCorrectionResult {
  applied: boolean;
  /** The patched pending to store (only when applied). */
  updatedPending?: Record<string, unknown>;
  /** Confirmation card body text (only when applied). */
  body?: string;
  /** Buttons for the confirmation prompt (only when applied). */
  buttons?: Array<{ id: string; title: string }>;
}

/**
 * If `pending` is an expense/income and `text` is a category or amount correction
 * ("no, era en sueldos" / "no, eran 75 mil"), patch the pending and render a fresh
 * confirmation card. Returns { applied: false } otherwise. Pure except for Date.now().
 */
export function tryApplyPendingCorrection(
  text: string,
  pending: Record<string, unknown> | undefined,
): PendingCorrectionResult {
  if (!pending || (pending.type !== 'expense' && pending.type !== 'income')) {
    return { applied: false };
  }
  const correctedCat = extractCategoryCorrection(text);
  const correctedAmt = extractAmountCorrection(text);
  if (!correctedCat && !correctedAmt) return { applied: false };

  const data = (pending.data ?? {}) as Record<string, unknown>;
  const updated: Record<string, unknown> = { ...pending, data: { ...data, timestamp: Date.now() } };
  const updatedData = updated.data as Record<string, unknown>;

  if (correctedCat) {
    const canonical =
      pending.type === 'income'
        ? (detectarCategoriaIngreso(correctedCat) || correctedCat)
        : (detectarCategoria(correctedCat) || correctedCat);
    updatedData.category = canonical;
  }
  if (correctedAmt) updatedData.amount = correctedAmt;

  const verb = pending.type === 'expense' ? 'gasto' : 'ingreso';
  const emoji = pending.type === 'expense' ? '💸' : '💰';
  const loc = pending.plotName
    ? `Lote ${pending.plotName} (${pending.fieldName})`
    : (pending.fieldName as string) || '—';
  const body = `${emoji} ¿Confirmo ${verb}?\n\nCategoría: *${updatedData.category}*\nMonto: *${formatMoney(updatedData.amount as number, updatedData.currency as string)}*\nUbicación: ${loc}`;
  const buttons = [
    { id: 'confirm_pending', title: 'Confirmar' },
    { id: 'cancel_pending', title: 'Cancelar' },
  ];
  return { applied: true, updatedPending: updated, body, buttons };
}
