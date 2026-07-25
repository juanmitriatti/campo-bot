/**
 * Guards de audio compartidos entre canales (Jul 2026). Antes el límite de
 * audios por hora y el largo máximo vivían solo en el controller de WhatsApp —
 * Telegram transcribía sin límite (costo Whisper sin tope). Fuente única para
 * los dos canales; el copy de rechazo también sale de acá para que el usuario
 * vea el mismo mensaje sin importar el canal.
 */
import { getSettingNumber } from '../settings.service.js';
import { getHourlyAudioCount } from '../expenses.js';
import { getAudioConfig } from './audio.types.js';

export const DEFAULT_MAX_AUDIO_PER_HOUR = 10;

export type AudioGuardResult =
  | { ok: true }
  | { ok: false; reason: 'hourly_limit' | 'too_long'; message: string };

/**
 * Chequea rate-limit horario y, cuando se conoce (Telegram la trae exacta en
 * el update), la duración máxima. WhatsApp no conoce la duración antes de
 * descargar — ahí el largo lo sigue cortando TranscriptionService
 * (AudioTooLongError) con la estimación por tamaño.
 */
export async function checkAudioGuards(
  userId: number,
  durationSeconds?: number | null,
): Promise<AudioGuardResult> {
  const maxPerHour = (await getSettingNumber('MAX_AUDIO_PER_HOUR')) ?? DEFAULT_MAX_AUDIO_PER_HOUR;
  const hourlyCount = await getHourlyAudioCount(userId);
  if (hourlyCount >= maxPerHour) {
    return {
      ok: false,
      reason: 'hourly_limit',
      message: `⚠️ Alcanzaste el límite de ${maxPerHour} audios por hora. Podés escribir tu mensaje o intentar más tarde.`,
    };
  }

  if (durationSeconds != null && durationSeconds > 0) {
    const maxDuration = getAudioConfig().maxAudioDurationSeconds;
    if (durationSeconds > maxDuration) {
      return {
        ok: false,
        reason: 'too_long',
        message: '⚠️ El audio es demasiado largo. Enviá un audio más corto o escribí el mensaje.',
      };
    }
  }

  return { ok: true };
}
