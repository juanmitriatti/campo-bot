import { getSetting } from './settings.service.js';

/**
 * Línea de soporte para mensajes del bot (checklist de lanzamiento, Jul 2026).
 * Devuelve '' cuando SUPPORT_CONTACT no está configurado — los mensajes se
 * arman igual, solo sin la línea. Un solo formato para todos los sitios
 * (comando plan, trial vencido, ayuda) así no divergen.
 */
export async function getSupportLine(): Promise<string> {
  const contact = ((await getSetting('SUPPORT_CONTACT')) ?? '').trim();
  if (!contact) return '';
  return `🆘 Soporte: ${contact}`;
}
