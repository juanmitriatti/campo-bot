import { formSessionService } from '../services/form-session.service.js';
import { getSetting } from '../services/settings.service.js';
import { FORM_DEFINITIONS } from './form-definitions.js';
import { resolveWhatsAppFormProvider } from './form-provider.js';
import { appendMetaFlowOffer } from './form-offer-meta-flow.js';
import { startConversationForm, resumeConversationForm } from './conversation/form-conversation.service.js';
import type { BotResponseItem, ChannelContext } from '../services/message-pipeline.js';
import type { HandlerResponse } from '../types/index.js';

/** channel_id "crudo" por canal: telegram guarda tg_<chatId> en phone. */
function rawChannelId(ctx: ChannelContext): string {
  if (ctx.channel === 'telegram') return ctx.phone.replace(/^tg_/, '');
  return ctx.phone;
}

/**
 * Presentación del formulario que un handler ofreció (sideEffects.offerForm)
 * o del que el usuario pidió retomar (sideEffects.resumeForm), según el canal:
 *   - Telegram / test-bot: botón web_app → /form/:token (Mini App).
 *   - WhatsApp: según WHATSAPP_FORM_PROVIDER (form-provider.ts):
 *       conversation (HOY)  → colector conversacional por chat.
 *       meta_flow (FUTURO)  → WhatsApp Flow (form-offer-meta-flow.ts).
 * La definición y el submit son los mismos en todos los casos.
 */
export async function appendFormOffer(
  items: BotResponseItem[],
  response: HandlerResponse,
  ctx: ChannelContext,
): Promise<void> {
  const resume = response.sideEffects?.resumeForm;
  if (resume) {
    items.push(...(await resumeConversationForm(ctx, resume.action ?? null)));
    return;
  }

  const offer = response.sideEffects?.offerForm;
  if (!offer) return;
  const def = FORM_DEFINITIONS[offer.action];
  if (!def) {
    console.log(`[FORM] skip offer: action desconocida ${String(offer.action)}`);
    return;
  }
  const body = offer.explicit
    ? `📝 Tocá para abrir el formulario de ${def.label.replace(/^(la|el) /, '')}:`
    : `📝 Si preferís, cargá ${def.label} con un formulario:`;
  // El usuario lo pidió y el canal no puede: se le dice, nunca un "abrí el
  // formulario" sin botón (visto en WhatsApp sin flow_id, 6 sep 2026).
  const unavailable = (): void => {
    if (!offer.explicit) return;
    items.push({
      type: 'text',
      text: `📝 Por acá el formulario de ${def.label.replace(/^(la|el) /, '')} todavía no está disponible. Contámelo por texto y lo registro igual.`,
    });
  };

  if (ctx.channel === 'whatsapp') {
    const provider = await resolveWhatsAppFormProvider(def);
    if (provider.kind === 'meta_flow') {
      // TODO / FUTURE: Meta Flow implementation retained for future activation.
      await appendMetaFlowOffer(items, response, ctx, offer, def, provider.flowId, body, unavailable);
      return;
    }
    // Colector conversacional. Solo cuando el usuario PIDIÓ el formulario: una
    // oferta implícita llega con el handler ya preguntando por su pending o su
    // flow, y abrir un segundo colector haría dos preguntas a la vez.
    if (!offer.explicit) {
      console.log(`[FORM] offer implícita omitida (conversation) action=${offer.action}`);
      return;
    }
    // hadPending no aplica: el colector ES el único que pregunta (no convive
    // con un pending del handler como el form web, que lo marca para el 409).
    items.push(...(await startConversationForm(ctx, { action: offer.action, prefill: offer.prefill ?? {} })));
    return;
  }

  const publicUrl = ((await getSetting('PUBLIC_URL')) as string) || '';
  if (!publicUrl) {
    console.log('[FORM] skip offer: PUBLIC_URL vacío');
    unavailable();
    return;
  }
  const token = await formSessionService.create({
    userId: Number(ctx.userId),
    action: offer.action,
    prefill: offer.prefill ?? {},
    channel: ctx.channel,
    channelId: rawChannelId(ctx),
    phone: ctx.phone,
    hadPending: !!response.sideEffects?.setPendingActivity,
    mode: 'web',
  });
  const url = `${publicUrl.replace(/\/$/, '')}/form/${token}`;
  items.push({
    type: 'interactive',
    interactive: {
      type: 'buttons',
      body,
      buttons: [{ id: `form_open_${token}`, title: '📝 Abrir formulario', webAppUrl: url }],
    },
  });
}
