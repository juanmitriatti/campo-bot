export interface PendingFieldLocation {
  fieldId: number;
  fieldName: string;
  timestamp: number;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingFieldLocationStore {
  private store = new Map<string, PendingFieldLocation>();

  set(key: string, data: Omit<PendingFieldLocation, 'timestamp'>): void {
    this.store.set(key, { ...data, timestamp: Date.now() });
  }

  get(key: string): PendingFieldLocation | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > PENDING_TIMEOUT_MS) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  clear(key: string): void {
    this.store.delete(key);
  }
}
