/**
 * Botón que CONTESTA la pregunta abierta con un texto sin ambigüedad.
 *
 * Sirve cuando la respuesta del usuario se puede leer de dos maneras ("80
 * lucas" sobre 10 bolsas: ¿total o por bolsa?): en vez de adivinar, cada botón
 * lleva la lectura escrita de forma inequívoca ("80000 en total" / "a 80000
 * cada una") y entra por el mismo camino que un mensaje del usuario. No hay un
 * segundo camino de guardado ni un comando propio.
 *
 * Solo vale mientras la pregunta sigue abierta: si ya se contestó (el otro
 * botón, o por escrito), el toque no hace nada.
 */
import { callbackPayloadStore } from './callback-payload-store.js';

export const ANSWER_PREFIX = 'ans_';

export function answerButton(title: string, text: string, answers: string): { id: string; title: string } {
  // `answers`: comando de la pregunta abierta que este botón contesta.
  return { id: `${ANSWER_PREFIX}${callbackPayloadStore.set(JSON.stringify({ text, answers }))}`, title: title.slice(0, 20) };
}

export function readAnswer(callbackId: string): { text: string; answers: string } | null {
  if (!callbackId.startsWith(ANSWER_PREFIX)) return null;
  const raw = callbackPayloadStore.get(callbackId.slice(ANSWER_PREFIX.length));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { text?: unknown; answers?: unknown };
    return typeof p.text === 'string' && typeof p.answers === 'string' ? { text: p.text, answers: p.answers } : null;
  } catch {
    return null;
  }
}
