export interface PendingFieldCity {
  fieldName: string;
  timestamp: number;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingFieldCityStore {
  private store = new Map<string, PendingFieldCity>();

  set(phone: string, data: PendingFieldCity): void {
    this.store.set(phone, data);
  }

  get(phone: string): PendingFieldCity | null {
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
