/**
 * invite-link.ts — FUENTE ÚNICA de cómo se ENTREGA una invitación a un campo.
 *
 * Por qué un link `wa.me` y no un mensaje del bot al invitado:
 * este repo NO tiene soporte de plantillas de WhatsApp (`type:"template"` no
 * existe en `services/whatsapp.js`). Todo envío es free-form, y Meta solo
 * entrega free-form dentro de la ventana de 24 h desde el último mensaje DEL
 * USUARIO. O sea que el bot no le puede escribir a un número que nunca le
 * habló — que es exactamente el caso de alguien a quien recién invitás.
 * Ver docs/operations.md § "Ventana de 24 hs de Meta".
 *
 * La salida es entonces un link que el DUEÑO reenvía por su propio WhatsApp:
 * el invitado lo toca, se le abre el chat con el bot con el texto ya escrito, y
 * solo tiene que mandarlo. Es el análogo WhatsApp del deep-link de Telegram que
 * ya se usa para vincular cuenta (`t.me/<bot>?start=verify_<token>`).
 *
 * Lo consumen la ruta REST del dashboard Y el handler del bot: dos textos
 * armados por separado serían dos códigos distintos en la misma pantalla.
 */

import { getSetting } from '../../services/settings.service.js';

export interface InviteDelivery {
  code: string;
  /** El texto que el invitado va a mandarle al bot. */
  waText: string;
  /** `null` si no hay número de bot configurado — se cae al código pelado. */
  waLink: string | null;
  /** Link de alta guiada, para un invitado que todavía no tiene cuenta. */
  registerLink: string | null;
  expiresAt: string | null;
}

/** El texto exacto que redime la invitación. Un solo lugar lo decide. */
export function inviteText(code: string): string {
  return `unirme ${code}`;
}

/**
 * Arma el link y el texto de una invitación.
 *
 * Con `WHATSAPP_BOT_NUMBER` vacío devuelve `waLink: null` y todo sigue
 * funcionando con el código pelado, que es el comportamiento de hoy: la
 * ausencia de configuración nunca rompe el flujo, solo lo deja más manual.
 */
export async function buildInviteDelivery(opts: {
  code: string;
  expiresAt?: Date | string | null;
}): Promise<InviteDelivery> {
  const code = opts.code;
  const waText = inviteText(code);

  let waLink: string | null = null;
  let registerLink: string | null = null;

  try {
    const raw = (await getSetting('WHATSAPP_BOT_NUMBER'))?.trim();
    if (raw) {
      // El número del bot va como lo espera wa.me: solo dígitos, sin `+`.
      const digits = raw.replace(/\D/g, '');
      if (digits) waLink = `https://wa.me/${digits}?text=${encodeURIComponent(waText)}`;
    }
  } catch {
    /* sin settings disponibles: se entrega el código pelado */
  }

  try {
    const publicUrl = (await getSetting('PUBLIC_URL'))?.trim();
    if (publicUrl && /^https?:\/\//.test(publicUrl)) {
      registerLink = `${publicUrl.replace(/\/$/, '')}/register?invite=${encodeURIComponent(code)}`;
    }
  } catch {
    /* idem */
  }

  const expiresAt = opts.expiresAt
    ? new Date(opts.expiresAt).toISOString()
    : null;

  return { code, waText, waLink, registerLink, expiresAt };
}

/**
 * El mensaje que ve el DUEÑO en el chat después de compartir. Está acá y no en
 * el handler para que el bot y el dashboard digan lo mismo.
 */
export function renderInviteMessage(opts: {
  fieldName: string;
  delivery: InviteDelivery;
  invitedPhone?: string | null;
}): string {
  const { fieldName, delivery, invitedPhone } = opts;
  const lines: string[] = [];

  lines.push(`🔗 *Invitación a ${fieldName}*`);
  lines.push('');

  if (delivery.waLink) {
    lines.push(
      invitedPhone
        ? 'Mandale este link a la persona por WhatsApp:'
        : 'Mandale este link a quien quieras darle acceso:',
    );
    lines.push(delivery.waLink);
    lines.push('');
    lines.push(`Si prefiere escribirlo, el código es \`${delivery.code}\` y tiene que mandar *${delivery.waText}*.`);
  } else {
    lines.push(`Código: \`${delivery.code}\``);
    lines.push('');
    lines.push(`Compartilo con quien quieras darle acceso. La otra persona debe escribir:\n*${delivery.waText}*`);
  }

  if (invitedPhone) {
    lines.push('');
    lines.push('🔒 Solo ese número puede usarla.');
  }

  lines.push('');
  lines.push('⏳ Vence en 7 días.');

  return lines.join('\n');
}
