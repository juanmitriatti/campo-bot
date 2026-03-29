export interface PendingPlotArea {
  plotId: number;
  plotName: string;
  fieldName: string;
  timestamp: number;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingPlotAreaStore {
  private store = new Map<string, PendingPlotArea>();

  set(phone: string, data: PendingPlotArea): void {
    this.store.set(phone, data);
  }

  get(phone: string): PendingPlotArea | null {
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
