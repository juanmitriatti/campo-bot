export interface PendingPlotArea {
  plotId: number;
  plotName: string;
  fieldName: string;
  timestamp: number;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingPlotAreaStore {
  private store = new Map<string, PendingPlotArea[]>();

  set(phone: string, data: PendingPlotArea): void {
    this.store.set(phone, [data]);
  }

  setQueue(phone: string, items: PendingPlotArea[]): void {
    if (items.length === 0) return;
    this.store.set(phone, items);
  }

  get(phone: string): PendingPlotArea | null {
    const queue = this.store.get(phone);
    if (!queue || queue.length === 0) {
      this.store.delete(phone);
      return null;
    }
    const first = queue[0];
    if (Date.now() - first.timestamp > PENDING_TIMEOUT_MS) {
      this.store.delete(phone);
      return null;
    }
    return first;
  }

  /** Remove the first item from the queue and return the next one (or null). */
  dequeueFirst(phone: string): PendingPlotArea | null {
    const queue = this.store.get(phone);
    if (!queue || queue.length === 0) {
      this.store.delete(phone);
      return null;
    }
    queue.shift();
    if (queue.length === 0) {
      this.store.delete(phone);
      return null;
    }
    // Reset timestamp on remaining items so timeout starts fresh
    const now = Date.now();
    queue[0].timestamp = now;
    return queue[0];
  }

  /** Count of items remaining in the queue. */
  remaining(phone: string): number {
    const queue = this.store.get(phone);
    if (!queue) return 0;
    return queue.length;
  }

  clear(phone: string): void {
    this.store.delete(phone);
  }
}
