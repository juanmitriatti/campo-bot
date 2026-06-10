import { PendingMirror } from './pending-persistence.js';

export interface PendingFieldCity {
  fieldName: string;
  timestamp: number;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingFieldCityStore {
  private store = new Map<string, PendingFieldCity>();
  private mirror = new PendingMirror<PendingFieldCity>('field_city', PENDING_TIMEOUT_MS);

  set(phone: string, data: PendingFieldCity): void {
    // Defensive: overwrite timestamp so the 5-min TTL always kicks in
    // even when the caller forgot to populate it.
    const entry = { ...data, timestamp: Date.now() };
    this.store.set(phone, entry);
    this.mirror.persist(phone, entry);
  }

  get(phone: string): PendingFieldCity | null {
    const pending = this.store.get(phone);
    if (!pending) return null;
    if (Date.now() - pending.timestamp > PENDING_TIMEOUT_MS) {
      this.clear(phone);
      return null;
    }
    return pending;
  }

  clear(phone: string): void {
    this.store.delete(phone);
    this.mirror.remove(phone);
  }

  /** Rellena el Map desde DB tras un restart (fill-if-missing). */
  async hydrate(phone: string): Promise<void> {
    if (this.store.has(phone)) return;
    const entry = await this.mirror.load(phone);
    if (entry) this.store.set(phone, entry);
  }
}
