import { extractCategoryCorrection, extractAmountCorrection, inheritAmountScale } from './conversation-engine.js';
import { detectarCategoria, detectarCategoriaIngreso } from '../utils/parser.js';
import { formatMoney } from '../utils/format-money.js';
import { detectCurrencyTerm, COPULA_ALT, CORRECTION_ALT, normLex } from '../utils/lexicon.js';

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
  let correctedAmt = extractAmountCorrection(text);
  if (correctedAmt != null) {
    const prevAmt = Number(((pending.data ?? {}) as Record<string, unknown>).amount) || null;
    correctedAmt = inheritAmountScale(correctedAmt, prevAmt, text, (((pending.data ?? {}) as Record<string, unknown>).currency as string | null) ?? null);
  }
  // Currency correction ("no, eran en dólares" / "perdón, eran verdes"). Without
  // this, the message fell through to the agent which emitted a NEW income that
  // replaced the pending → the old ARS pending got auto-committed as a duplicate
  // ghost alongside the new USD row (P1-D). Patch the currency in place instead.
  // Currency synonyms (verdes, mangos, …) live in lexicon.detectCurrencyTerm.
  let correctedCurrency: 'USD' | 'ARS' | null = null;
  if (new RegExp(`\\b(?:${COPULA_ALT}|${CORRECTION_ALT}|en)\\b`, 'i').test(normLex(text))) {
    correctedCurrency = detectCurrencyTerm(text);
  }
  if (!correctedCat && !correctedAmt && !correctedCurrency) return { applied: false };

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
  if (correctedCurrency) updatedData.currency = correctedCurrency;

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
