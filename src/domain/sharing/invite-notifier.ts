/**
 * invite-notifier.ts — punto de extensión para AVISARLE al invitado.
 *
 * Hoy es un noop deliberado, no un olvido.
 *
 * `services/whatsapp.js` no tiene soporte de plantillas (`type:"template"`), y
 * Meta solo entrega mensajes free-form dentro de la ventana de 24 h desde el
 * último mensaje DEL USUARIO. Alguien a quien recién invitás, por definición,
 * nunca le escribió al bot: cualquier envío directo se lo rechaza Meta. Por eso
 * la entrega real es el link `wa.me` que el dueño reenvía (ver `invite-link.ts`).
 *
 * La interfaz existe igual para que el día que haya una plantilla aprobada se
 * enchufe una implementación acá y ni la ruta ni la UI cambien: las dos ya leen
 * el resultado (`delivery: 'sent' | 'link'`).
 *
 * El skip se LOGUEA desde el día uno (invariante 1): un veto mudo es
 * indistinguible de "nunca pasó".
 */

export interface InviteRef {
  code: string;
  fieldId: number;
}

export interface InviteNotifier {
  /**
   * `'sent'` si el invitado recibió un mensaje del bot; `'skipped'` si hay que
   * entregarle el link a mano.
   */
  notify(invite: InviteRef, targetPhone: string | null): Promise<'sent' | 'skipped'>;
}

class NoopInviteNotifier implements InviteNotifier {
  async notify(invite: InviteRef, targetPhone: string | null): Promise<'skipped'> {
    console.log(
      `[SHARING] notify skipped (sin plantilla aprobada de Meta) invite=${invite.code} campo=${invite.fieldId} destino=${targetPhone ?? 'código abierto'}`,
    );
    return 'skipped';
  }
}

export const inviteNotifier: InviteNotifier = new NoopInviteNotifier();
