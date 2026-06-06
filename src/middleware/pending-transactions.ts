import type { PendingTransaction } from '../types/index.js';
import { formatMoney } from '../utils/format-money.js';

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingTransactionStore {
  private store = new Map<string, PendingTransaction>();

  /**
   * Set the user's pending confirmation. If there was already a non-expired
   * pending in slot, returns it so callers can warn the user ("cancelamos la
   * confirmación anterior, esta es la nueva"). Otherwise returns null.
   *
   * This prevents the failure mode where the user fires 3 rapid "registra X"
   * messages — Telegram shows 3 confirm cards, the store only keeps the last,
   * and tapping the OLDEST card silently confirms the LATEST registration.
   */
  set(phone: string, tx: PendingTransaction): PendingTransaction | null {
    const prev = this.get(phone); // get() already filters expired
    // Defensive: overwrite timestamp so the 5-min TTL always works.
    this.store.set(phone, { ...tx, timestamp: Date.now() });
    return prev;
  }

  get(phone: string): PendingTransaction | null {
    const pending = this.store.get(phone);
    if (!pending) return null;
    if (Date.now() - pending.timestamp > PENDING_TIMEOUT_MS) {
      this.store.delete(phone);
      return null;
    }
    return pending;
  }

  clear(phone: string): void {
    this.store.delete(phone);
  }
}

/**
 * Describe the replaced pending so the user sees what we cancelled.
 * Used by controllers to prepend a "🔁 Cancelé X" warning before the new
 * confirmation buttons.
 */
export function describeReplacedPending(prev: PendingTransaction): string {
  const kind = prev.type === 'income' ? 'ingreso' : prev.type === 'expense' ? 'gasto' : 'registro';
  const data = (prev as unknown as { data?: { amount?: number; category?: string; currency?: string } }).data ?? {};
  const hasMoney = typeof data.amount === 'number';
  const money = hasMoney ? formatMoney(data.amount as number, data.currency ?? 'ARS') : '';
  const cat = data.category ? ` ${data.category}` : '';
  const detail = hasMoney ? ` (${cat.trim()} ${money})`.replace(/\(\s+/, '(') : (cat ? ` (${cat.trim()})` : '');
  return `🔁 Cancelé el ${kind} anterior${detail} para registrar el nuevo. Confirmá abajo o cancelá si fue un error.`;
}

/** A replaced pending is "complete" when it could be saved as-is (amount + category). */
function isCompletePending(prev: PendingTransaction): boolean {
  const d = (prev as unknown as { data?: { amount?: number; category?: string } }).data ?? {};
  return (prev.type === 'expense' || prev.type === 'income')
    && typeof d.amount === 'number' && d.amount > 0
    && !!(d.category && String(d.category).trim());
}

function describeCommittedPending(prev: PendingTransaction): string {
  const kind = prev.type === 'income' ? 'ingreso' : 'gasto';
  const data = (prev as unknown as { data?: { amount?: number; category?: string; currency?: string } }).data ?? {};
  const money = formatMoney(data.amount as number, data.currency ?? 'ARS');
  const cat = data.category ? `${data.category} ` : '';
  return `✅ Guardé el ${kind} anterior (${cat}${money}) y registro el nuevo.`;
}

/**
 * When a new expense/income replaces an unconfirmed pending: if the old pending
 * was COMPLETE, auto-commit it (don't discard the user's data) and announce it;
 * otherwise just describe that it was cancelled. Returns the message to prepend.
 */
export async function resolveReplacedPending(
  prev: PendingTransaction,
  commit: (p: PendingTransaction) => Promise<void>,
): Promise<string> {
  if (isCompletePending(prev)) {
    try {
      await commit(prev);
      return describeCommittedPending(prev);
    } catch {
      return describeReplacedPending(prev);
    }
  }
  return describeReplacedPending(prev);
}
