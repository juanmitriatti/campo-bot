export interface PendingPlotArea {
  plotId: number;
  plotName: string;
  fieldName: string;
  timestamp: number;
  /** 1-based position in the ORIGINAL queue (for a stable "(2 de 4)" counter). */
  seq?: number;
  /** Original queue length (denominator of the counter). */
  total?: number;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingPlotAreaStore {
  private store = new Map<string, PendingPlotArea[]>();

  set(phone: string, data: PendingPlotArea): void {
    // Defensive: overwrite timestamp so the 5-min TTL always works.
    this.store.set(phone, [{ ...data, timestamp: Date.now(), seq: 1, total: 1 }]);
  }

  setQueue(phone: string, items: PendingPlotArea[]): void {
    if (items.length === 0) return;
    const now = Date.now();
    const total = items.length;
    this.store.set(phone, items.map((it, i) => ({ ...it, timestamp: now, seq: i + 1, total })));
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

  /** Snapshot of all items still pending (empty array if none / expired). */
  items(phone: string): PendingPlotArea[] {
    const queue = this.store.get(phone);
    if (!queue || queue.length === 0) return [];
    if (Date.now() - queue[0].timestamp > PENDING_TIMEOUT_MS) {
      this.store.delete(phone);
      return [];
    }
    return queue.map(it => ({ ...it }));
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

  /** Remove a specific item by plotId; returns the (new) first remaining item or null. */
  removeByPlotId(phone: string, plotId: number): PendingPlotArea | null {
    const queue = this.store.get(phone);
    if (!queue || queue.length === 0) {
      this.store.delete(phone);
      return null;
    }
    const idx = queue.findIndex(it => it.plotId === plotId);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) {
      this.store.delete(phone);
      return null;
    }
    queue[0].timestamp = Date.now();
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
