export interface PendingActivity {
  command: string;               // 'log_spraying' | 'log_fertilization' | ... | 'sow_crop' | 'harvest_crop'
  data: Record<string, unknown>; // Full cmd object from handler
  timestamp: number;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingActivityStore {
  private store = new Map<string, PendingActivity>();

  set(phone: string, activity: PendingActivity): void {
    this.store.set(phone, activity);
  }

  get(phone: string): PendingActivity | null {
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
