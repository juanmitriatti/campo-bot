export interface PendingObservation {
  text: string;
  category: string;
  timestamp: number;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingObservationStore {
  private store = new Map<string, PendingObservation>();

  set(phone: string, obs: PendingObservation): void {
    this.store.set(phone, obs);
  }

  get(phone: string): PendingObservation | null {
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
