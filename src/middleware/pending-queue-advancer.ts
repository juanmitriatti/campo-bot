import type { PendingActivity, PendingActivityStore } from './pending-activities.js';
import type { HandlerResponse } from '../types/index.js';

/**
 * After a pending activity successfully completes (slots filled + handler
 * re-routed), decide what to do with the serial queue.
 *
 * - If the re-routed command itself set a NEW setPendingActivity, that one
 *   takes priority. The remaining queue (if any) is appended to its
 *   nextInQueue so nothing is lost.
 * - Otherwise, pop the FIRST item from the just-completed pending's
 *   nextInQueue → set as new current pending → return its askPrompt so the
 *   controller can send it to the user.
 * - When the queue is empty, return null (no further follow-up needed).
 *
 * Returns:
 *   - { askPrompt: string } when a new pending was set + caller should send the prompt
 *   - null when the queue is empty or a fresh pending took over with its own ask
 */
export interface QueueAdvanceResult {
  /** Spanish prompt to send to the user for the new queue head. Null = nothing to send. */
  askPrompt: string | null;
}

export function advanceQueueAfterCompletion(
  store: PendingActivityStore,
  phone: string,
  justCompleted: PendingActivity,
  cmdResult: HandlerResponse | null,
): QueueAdvanceResult {
  const remaining = justCompleted.nextInQueue ?? [];

  // Case A: the re-routed command itself set a NEW setPendingActivity.
  // Append our remaining queue to it so nothing is lost. The new pending's
  // own askPrompt is shown via the cmdResult.messages flow.
  if (cmdResult?.sideEffects?.setPendingActivity) {
    const next = cmdResult.sideEffects.setPendingActivity;
    const mergedQueue = [
      ...(next.nextInQueue ?? []),
      ...remaining,
    ];
    store.set(phone, {
      command: next.command,
      data: next.data,
      timestamp: Date.now(),
      missing: next.missing,
      askPrompt: next.askPrompt,
      ...(mergedQueue.length > 0 ? { nextInQueue: mergedQueue } : {}),
    });
    return { askPrompt: null };
  }

  // Case B: no new pending. If we still have items in the queue, promote
  // the first to current and ask its prompt.
  if (remaining.length > 0) {
    const [head, ...tail] = remaining;
    store.set(phone, {
      command: head.command,
      data: head.data,
      timestamp: Date.now(),
      missing: head.missing,
      askPrompt: head.askPrompt,
      ...(tail.length > 0 ? { nextInQueue: tail } : {}),
    });
    return { askPrompt: head.askPrompt ?? 'Me falta algún dato para la próxima acción. ¿Me lo pasás?' };
  }

  // Case C: queue empty, nothing to do.
  return { askPrompt: null };
}
