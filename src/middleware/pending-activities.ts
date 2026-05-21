export interface PendingActivity {
  command: string;               // 'log_spraying' | 'log_fertilization' | ... | 'sow_crop' | 'harvest_crop'
  data: Record<string, unknown>; // Full cmd object from handler (already-filled slots)
  timestamp: number;
  /**
   * Required slots that are still missing. When present, the controller runs
   * the SlotExtractor against each new user message and merges any newly
   * extracted slots into `data`. When `missing` becomes empty, the command is
   * re-executed automatically.
   *
   * Legacy `_needs: 'crop'` is still supported but the `missing` array is the
   * canonical multi-slot form (it can be ['product','plot','quantity']).
   */
  missing?: string[];
  /** Plain-Spanish prompt to show when asking for the still-missing slots. */
  askPrompt?: string;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PendingActivityStore {
  private store = new Map<string, PendingActivity>();

  // Defensive: always overwrite timestamp on set so the 5-min TTL works
  // even when callers (handlers/sideEffects) forget to populate it. The
  // previous code accepted whatever the caller passed; most call sites
  // omitted timestamp, leaving it undefined → Date.now() - undefined is
  // NaN → the TTL check never triggered → pendings lived forever.
  set(phone: string, activity: PendingActivity): void {
    this.store.set(phone, { ...activity, timestamp: Date.now() });
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
