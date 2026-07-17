/**
 * conversation-lock-store — "modo conversacional pegajoso". Cuando el agente
 * responde una aclaración (respond_text, SIN ejecutar acción), el pipeline no
 * dejaba estado: cada follow-up ambiguo volvía a entrar por el trivial bypass y
 * a veces se misruteaba (visto live: "como que no?" → financial_report(hacienda)).
 *
 * Este store marca que hay una aclaración en curso. Mientras esté activo,
 * intent-classifier saltea el trivial bypass y manda el mensaje al agente con un
 * hint. Sale por tope de turnos (CONVERSATION_LOCK_MAX_TURNS, default 5): cada
 * respuesta conversacional suma un turno; una acción real resetea a 0 (sigue en
 * lock). TTL de 30 min como backstop (heredado de TypedPendingStore).
 *
 * Pending simple nuevo = TypedPendingStore (regla CLAUDE.md), NUNCA Map suelto.
 */
import { TypedPendingStore } from './typed-pending-store.js';
import { getSettingBool, getSettingNumber } from '../services/settings.service.js';

export const conversationLockStore = new TypedPendingStore<{ turns: number }>('conversation_lock');

/** Hint que viaja al agente por el carril del pendingHint (branch dedicado en
 *  agent.service). Empieza con "ACLARACIÓN EN CURSO" para su framing propio. */
export const CLARIFICATION_HINT =
  'ACLARACIÓN EN CURSO: ya le hiciste una pregunta al usuario en este hilo y todavía no la ' +
  'resolvió. NO repitas la misma pregunta verbatim. Avanzá hacia registrar la acción concreta ' +
  'con lo que te diga; si el mensaje no aporta nada útil, ofrecele escribir *menú* para ver las opciones.';

/** Se agrega a la respuesta conversacional cuando el lock se libera por tope de turnos. */
export const LOCK_RELEASED_SUFFIX = 'Si querés, escribí *menú* y te muestro todo lo que puedo registrar.';

/** Lógica pura del contador: dado el turno actual y el tope, devuelve el próximo
 *  turno y si se alcanzó el tope (lock liberado). */
export function evaluateLockBump(current: number, maxTurns: number): { turns: number; released: boolean } {
  const turns = current + 1;
  return { turns, released: turns >= maxTurns };
}

/** true si el lock está activo Y el kill switch está prendido. */
export async function isConversationLockActive(phone: string): Promise<boolean> {
  const enabled = (await getSettingBool('CONVERSATION_LOCK_ENABLED')) ?? true;
  if (!enabled) return false;
  return conversationLockStore.has(phone);
}

/**
 * El agente respondió conversacional (aclaración sin acción): ENTRAR o BUMP.
 * No-op si el kill switch está apagado. Devuelve { released } true si se alcanzó
 * el tope de turnos (lock liberado — el próximo mensaje vuelve al pipeline normal).
 */
export async function bumpConversationLock(phone: string): Promise<{ released: boolean; turns: number }> {
  const enabled = (await getSettingBool('CONVERSATION_LOCK_ENABLED')) ?? true;
  if (!enabled) return { released: false, turns: 0 };
  const maxTurns = (await getSettingNumber('CONVERSATION_LOCK_MAX_TURNS')) ?? 5;
  const existed = conversationLockStore.has(phone);
  const current = conversationLockStore.get(phone)?.turns ?? 0;
  const { turns, released } = evaluateLockBump(current, maxTurns);
  if (released) {
    conversationLockStore.clear(phone);
    console.log(`[CONV-LOCK] release (cap) phone=${phone} turns=${turns}`);
    return { released: true, turns };
  }
  conversationLockStore.set(phone, { turns });
  console.log(`[CONV-LOCK] ${existed ? 'continue' : 'enter'} phone=${phone} turns=${turns}`);
  return { released: false, turns };
}

/** Se ejecutó una acción real: reset a 0 pero sigue en lock (solo si estaba activo). */
export function resetConversationLock(phone: string): void {
  if (!conversationLockStore.has(phone)) return;
  conversationLockStore.set(phone, { turns: 0 });
  console.log(`[CONV-LOCK] reset (acción) phone=${phone}`);
}
