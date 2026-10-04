import type { ParsedCommand } from '../../types/index.js';
import { callbackPayloadStore } from '../../middleware/callback-payload-store.js';

export type LivestockPayloadStep = 'create_loc' | 'pick_loc' | 'animals' | 'post_action';

export interface LivestockPendingPayload {
  cmd: ParsedCommand;
  step: LivestockPayloadStep;
  resolvedLocation?: {
    plotId: number | null;
    corralId: number | null;
    label: string;
  };
  missingType?: 'corral' | 'plot' | 'feedlot' | 'field';
  missingName?: string;
  feedlotId?: number;
  fieldName?: string;
  knownGroupCount?: number;
}

export function encodeLivestockPayload(p: LivestockPendingPayload): string {
  const json = JSON.stringify(p);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeLivestockPayload(b64: string): LivestockPendingPayload {
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
}

/**
 * Payload de un BOTÓN de hacienda: se guarda server-side y el botón lleva solo
 * el token (8 chars). Antes viajaba el comando entero en base64 dentro del id
 * (266–407 caracteres): Telegram corta en 64 bytes y WhatsApp en 256, así que
 * esos botones no llegaban (auditoría oct 2026, HAC-21). El token además queda
 * atado al usuario que recibió el botón.
 */
export function storeLivestockPayload(p: LivestockPendingPayload): string {
  return callbackPayloadStore.set(encodeLivestockPayload(p));
}

/** null = botón vencido, de otro usuario o ilegible (con log). */
export function readLivestockPayload(token: unknown): LivestockPendingPayload | null {
  if (typeof token !== 'string' || !token) return null;
  const raw = callbackPayloadStore.get(token);
  if (raw === null) {
    console.log(`[INTERCEPT] botón de hacienda sin token vigente: ${token.slice(0, 16)}`);
    return null;
  }
  try {
    return decodeLivestockPayload(raw);
  } catch {
    console.log(`[INTERCEPT] botón de hacienda con payload ilegible: ${token.slice(0, 16)}`);
    return null;
  }
}
