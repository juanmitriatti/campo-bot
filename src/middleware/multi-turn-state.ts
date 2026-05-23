/**
 * Helpers for the multi-turn query inheritance state stored on `conversation_state`.
 *
 * Stored columns: last_finance_query, last_activity_query, last_rainfall_query,
 * last_scouting_query, last_livestock_query (each JSONB).
 *
 * Companion column: last_query_ts (timestamp). Used to expire stored state after
 * a TTL so refinements ("y solo de soja?") don't pull in stale context from
 * minutes earlier when the user already moved on.
 *
 * Default TTL: 5 minutes. Beyond that, inherit:true acts as a fresh query.
 */

import { pool } from '../config/db.js';
import type { UserId } from '../types/index.js';

const MULTI_TURN_TTL_MS = 5 * 60 * 1000; // 5 minutes

const MULTI_TURN_COLS = [
  'last_finance_query',
  'last_activity_query',
  'last_rainfall_query',
  'last_scouting_query',
  'last_livestock_query',
] as const;

/**
 * Wipes all multi-turn query state for a user.
 * Called on `cancelar` / `clear` / fresh-context signals so that a later
 * inherit:true doesn't pull in unrelated leftover state.
 */
export async function clearMultiTurnState(userId: UserId): Promise<void> {
  try {
    const sets = MULTI_TURN_COLS.map(c => `${c} = NULL`).join(', ');
    await pool.query(
      `UPDATE conversation_state SET ${sets} WHERE user_id = $1`,
      [userId],
    );
  } catch {
    /* non-fatal */
  }
}

/**
 * Check whether a stored multi-turn query is still fresh.
 * Returns true if the timestamp is missing (no TTL info — accept) or within window.
 */
export function isFreshMultiTurnEntry(updatedAt: Date | string | null | undefined): boolean {
  if (!updatedAt) return true; // legacy rows without timestamp — accept
  const t = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  if (isNaN(t)) return true;
  return Date.now() - t <= MULTI_TURN_TTL_MS;
}
