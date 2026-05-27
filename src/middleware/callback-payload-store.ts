/**
 * Short-token registry for oversized callback_data payloads.
 *
 * Telegram limits callback_data to 64 BYTES. Some of our buttons (category
 * pickers, bulk-assign-plot, etc.) embed JSON-then-base64url payloads of
 * 150-200+ bytes inside callback_data — which works on WhatsApp (256-byte
 * id limit) but silently fails on Telegram (HTTP 400, swallowed by the
 * try/catch in telegram.controller.sendBotResponse, user sees nothing).
 *
 * This store lets handlers register a payload server-side and embed only
 * a short opaque token (~8 chars) in callback_data. When the user taps,
 * the interactive router looks up the original payload by token.
 *
 * Storage: in-memory Map with 10-minute TTL. Tokens are 6 random bytes
 * (base64url-encoded, ~8 chars). Collisions are theoretically possible
 * but cleaned up by TTL — for a 10-min window with <1000 active picks
 * the collision probability is ~10^-12.
 *
 * Used by:
 *   - Category picker (cat_pick_exp_<token>_<categoryId>)
 *   - Category new   (cat_new_exp_<token>)
 *   - Mirror for income
 *
 * Not used by `confirm_pending` etc. — those don't carry payload (read
 * from pendingStore).
 */

import { randomBytes } from 'crypto';

const TTL_MS = 10 * 60 * 1000; // 10 minutes

class CallbackPayloadStore {
  private map = new Map<string, { payload: string; timestamp: number }>();

  /** Register a payload, return a short token to embed in callback_data. */
  set(payload: string): string {
    const token = randomBytes(6).toString('base64url'); // 8 chars
    this.map.set(token, { payload, timestamp: Date.now() });
    if (this.map.size > 500) this.cleanup();
    return token;
  }

  /** Look up a payload by token. Returns null if missing or expired. */
  get(token: string): string | null {
    const entry = this.map.get(token);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > TTL_MS) {
      this.map.delete(token);
      return null;
    }
    return entry.payload;
  }

  /** Best-effort cleanup of expired entries — called when map grows large. */
  private cleanup(): void {
    const now = Date.now();
    for (const [token, entry] of this.map) {
      if (now - entry.timestamp > TTL_MS) this.map.delete(token);
    }
  }

  /** For tests. */
  _clear(): void {
    this.map.clear();
  }

  /** For tests/observability. */
  get size(): number {
    return this.map.size;
  }
}

export const callbackPayloadStore = new CallbackPayloadStore();
