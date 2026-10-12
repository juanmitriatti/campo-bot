/**
 * whatsapp-link.ts — FUENTE ÚNICA del link `wa.me` al bot.
 *
 * El bot no le puede escribir a un número que nunca le habló (ventana de 24 h
 * de Meta y sin plantillas aprobadas), así que todo lo que tiene que LLEGARLE a
 * alguien nuevo va al revés: un link que abre el chat con el bot con el texto
 * ya escrito, y la persona solo lo manda. Lo usan la invitación a un campo
 * (`unirme CODIGO`) y la vinculación de WhatsApp (`verificar 123456`).
 *
 * Setting `WHATSAPP_BOT_NUMBER` (público, grupo system). Vacío → `null`, y cada
 * llamador cae a su camino sin link: la falta de configuración nunca rompe.
 */

import { getSetting } from '../services/settings.service.js';

/** El número visible del bot como lo espera wa.me: solo dígitos, sin `+`. */
export async function getBotWhatsAppNumber(): Promise<string | null> {
  try {
    const raw = ((await getSetting('WHATSAPP_BOT_NUMBER')) as string | null)?.trim();
    const digits = raw ? raw.replace(/\D/g, '') : '';
    return digits || null;
  } catch {
    return null;
  }
}

/** `https://wa.me/<bot>?text=<texto>`, o `null` sin número configurado. */
export async function buildBotWaLink(text: string): Promise<string | null> {
  const number = await getBotWhatsAppNumber();
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null;
}
