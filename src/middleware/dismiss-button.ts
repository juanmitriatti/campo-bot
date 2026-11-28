/**
 * Botón para DECIR QUE NO a algo opcional ("Ahora no", "No", "No, ya está").
 *
 * Antes todos usaban `cancel_action`: contestaba "❌ Operación cancelada"
 * aunque no se cancelara nada (la cosecha ya estaba registrada), y además
 * borraba la tarjeta "¿Confirmo?" que hubiera abierta sin tener que ver. Acá
 * cada botón lleva SU respuesta y dice qué pregunta cierra (o ninguna).
 *
 * `closes`: comando de la pregunta abierta (pendingActivity) que este "no"
 * cierra. Sin `closes`, no toca ningún estado: solo contesta.
 */
import { callbackPayloadStore } from './callback-payload-store.js';

export interface DismissPayload {
  reply: string;
  closes?: string;
}

export const DISMISS_PREFIX = 'dismiss_';

export function dismissButton(title: string, reply: string, opts: { closes?: string } = {}): { id: string; title: string } {
  const payload: DismissPayload = { reply, ...(opts.closes ? { closes: opts.closes } : {}) };
  return { id: `${DISMISS_PREFIX}${callbackPayloadStore.set(JSON.stringify(payload))}`, title };
}

export function readDismiss(callbackId: string): DismissPayload | null {
  if (!callbackId.startsWith(DISMISS_PREFIX)) return null;
  const raw = callbackPayloadStore.get(callbackId.slice(DISMISS_PREFIX.length));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as DismissPayload;
    return typeof p.reply === 'string' ? p : null;
  } catch {
    return null;
  }
}
