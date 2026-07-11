import { getSettingBool } from '../settings.service.js';

/**
 * Eco de transcripción (ronda 3, Jul 2026): el usuario nunca veía qué entendió
 * el STT — la mayoría de los errores del path de audio son transcripciones
 * malas indistinguibles de texto tipeado (ver STT_DOMAIN_CORRECTIONS). Con el
 * eco puede detectar el error y corregir en el momento.
 *
 * Devuelve null cuando está apagado (AUDIO_ECHO_TRANSCRIPT=false) o el texto
 * quedó vacío. Compartido por WhatsApp y Telegram.
 */
export async function buildTranscriptEcho(transcript: string): Promise<string | null> {
  if ((await getSettingBool('AUDIO_ECHO_TRANSCRIPT')) === false) return null;
  const t = (transcript ?? '').trim();
  if (!t) return null;
  const shown = t.length > 220 ? `${t.slice(0, 220)}…` : t;
  return `🎙️ _Entendí: «${shown}»_`;
}
