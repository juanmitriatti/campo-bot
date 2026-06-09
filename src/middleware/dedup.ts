const MAX_SIZE = 5000;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min — well beyond any webhook-retry window

/**
 * In-memory idempotency guard for webhook updates / callbacks.
 *
 * Time-windowed: each id is remembered for `ttlMs`. The old implementation used a
 * plain Set cleared wholesale at 1000 entries — a `clear()` could drop an id
 * milliseconds before its retry arrived, letting a duplicate slip through and
 * double-write (a single "320 madres" audio created the herd twice). Evicting by
 * AGE (not all-at-once) closes that window.
 *
 * Note: still per-process. If the app ever runs multiple replicas, dedup must
 * move to a shared store (e.g. a DB unique key on update_id) — this only protects
 * a single instance against retries/races.
 */
export class MessageDedup {
  private seen = new Map<string, number>(); // id → first-seen epoch ms
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  isDuplicate(messageId: string, now: number = Date.now()): boolean {
    const prev = this.seen.get(messageId);
    if (prev !== undefined && now - prev < this.ttlMs) return true;
    this.seen.set(messageId, now);
    if (this.seen.size > MAX_SIZE) this.evictExpired(now);
    return false;
  }

  private evictExpired(now: number): void {
    for (const [id, ts] of this.seen) {
      if (now - ts >= this.ttlMs) this.seen.delete(id);
    }
    // Hard cap fallback: if still over (lots of fresh ids), drop the oldest half.
    if (this.seen.size > MAX_SIZE) {
      const entries = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < Math.floor(entries.length / 2); i++) this.seen.delete(entries[i][0]);
    }
  }
}
