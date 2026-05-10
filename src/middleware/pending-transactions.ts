import type { PendingTransaction } from '../types/index.js';

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingTransactionStore {
  private store = new Map<string, PendingTransaction>();

  set(phone: string, tx: PendingTransaction): void {
    // Defensive: overwrite timestamp so the 5-min TTL always works.
    this.store.set(phone, { ...tx, timestamp: Date.now() });
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
