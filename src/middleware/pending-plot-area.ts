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

// 30 min (antes 5) — coherente con el resto de los pendings; el productor no
// contesta las hectáreas en 5 minutos si está arriba del tractor.
const PENDING_TIMEOUT_MS = 30 * 60 * 1000;

import { PendingMirror } from './pending-persistence.js';

interface PlotAreaQueueEntry {
  items: PendingPlotArea[];
  timestamp: number;
}

export class PendingPlotAreaStore {
  private store = new Map<string, PendingPlotArea[]>();
  // Espejo DB del contrato único: la cola entera viaja como un solo payload.
  // Antes este store era memoria pura — un deploy en medio de la tanda de
  // "¿cuántas has tiene X?" perdía toda la cola.
  private mirror = new PendingMirror<PlotAreaQueueEntry>('plot_area', PENDING_TIMEOUT_MS);

  private persist(phone: string): void {
    const queue = this.store.get(phone);
    if (!queue || queue.length === 0) {
      this.mirror.remove(phone);
      return;
    }
    this.mirror.persist(phone, { items: queue, timestamp: queue[0].timestamp });
  }

  async hydrate(phone: string): Promise<void> {
    if (this.store.has(phone)) return;
    const entry = await this.mirror.load(phone);
    if (entry && Array.isArray(entry.items) && entry.items.length > 0) {
      this.store.set(phone, entry.items);
    }
  }

  set(phone: string, data: PendingPlotArea): void {
    // Defensive: overwrite timestamp so the TTL always works.
    this.store.set(phone, [{ ...data, timestamp: Date.now(), seq: 1, total: 1 }]);
    this.persist(phone);
  }

  setQueue(phone: string, items: PendingPlotArea[]): void {
    if (items.length === 0) return;
    const now = Date.now();
    const total = items.length;
    this.store.set(phone, items.map((it, i) => ({ ...it, timestamp: now, seq: i + 1, total })));
    this.persist(phone);
  }

  get(phone: string): PendingPlotArea | null {
    const queue = this.store.get(phone);
    if (!queue || queue.length === 0) {
      this.store.delete(phone);
      return null;
    }
    const first = queue[0];
    if (Date.now() - first.timestamp > PENDING_TIMEOUT_MS) {
      this.clear(phone);
      return null;
    }
    return first;
  }

  /** Snapshot of all items still pending (empty array if none / expired). */
  items(phone: string): PendingPlotArea[] {
    const queue = this.store.get(phone);
    if (!queue || queue.length === 0) return [];
    if (Date.now() - queue[0].timestamp > PENDING_TIMEOUT_MS) {
      this.clear(phone);
      return [];
    }
    return queue.map(it => ({ ...it }));
  }

  /** Remove the first item from the queue and return the next one (or null). */
  dequeueFirst(phone: string): PendingPlotArea | null {
    const queue = this.store.get(phone);
    if (!queue || queue.length === 0) {
      this.clear(phone);
      return null;
    }
    queue.shift();
    if (queue.length === 0) {
      this.clear(phone);
      return null;
    }
    // Reset timestamp on remaining items so timeout starts fresh
    const now = Date.now();
    queue[0].timestamp = now;
    this.persist(phone);
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
      this.clear(phone);
      return null;
    }
    queue[0].timestamp = Date.now();
    this.persist(phone);
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
    this.mirror.remove(phone);
  }
}
