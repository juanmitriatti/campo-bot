import { formSessionService } from '../services/form-session.service.js';
import { getSetting } from '../services/settings.service.js';
import { FORM_DEFINITIONS } from './form-definitions.js';
import { resolveWhatsAppFormProvider } from './form-provider.js';
import { flowMarkerFor } from './form-flow-link.js';
import { appendMetaFlowOffer } from './form-offer-meta-flow.js';
import { startConversationForm, resumeConversationForm } from './conversation/form-conversation.service.js';
import type { BotResponseItem, ChannelContext } from '../services/message-pipeline.js';
import type { HandlerResponse } from '../types/index.js';

/** channel_id "crudo" por canal: telegram guarda tg_<chatId> en phone. */
function rawChannelId(ctx: ChannelContext): string {
  if (ctx.channel === 'telegram') return ctx.phone.replace(/^tg_/, '');
  return ctx.phone;
}

/** Tope de Meta para el cuerpo de un mensaje interactivo. */
const FLOW_BODY_MAX = 1024;

type OfferForm = NonNullable<NonNullable<HandlerResponse['sideEffects']>['offerForm']>;
type Definition = (typeof FORM_DEFINITIONS)[keyof typeof FORM_DEFINITIONS];

/** Resumen de lo que ya se entendió, más los avisos (⚠️) del handler. */
function offerSummary(def: Definition, prefill: Record<string, unknown>, messages: string[]): string {
  const warnings = messages.flatMap(m => m.split('\n')).filter(l => l.startsWith('⚠️'));
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const amount = typeof prefill.amount === 'number'
    ? `${prefill.currency === 'USD' ? 'US$' : '$'}${prefill.amount.toLocaleString('es-AR')}` : null;
  const carry = (prefill._carry ?? {}) as Record<string, unknown>;
  const extra = [
    typeof carry.quantity === 'number' && typeof prefill.quantity_tn !== 'number' ? `${carry.quantity.toLocaleString('es-AR')} ${text(carry.unit) ?? ''}`.trim() : null,
    text(carry.product),
    typeof carry.unit_price === 'number' ? `a ${carry.unit_price.toLocaleString('es-AR')} c/u` : null,
  ];
  const details = [text(prefill.category) ?? text(prefill.crop) ?? text(prefill.product), amount, ...extra,
    typeof prefill.quantity_tn === 'number' ? `${prefill.quantity_tn.toLocaleString('es-AR')} tn` : null,
    text(prefill.plotName) ? `lote ${text(prefill.plotName)}` : null].filter(Boolean).join(' — ');
  return [...warnings, def.title, details, 'Completá el formulario 👇'].filter(Boolean).join('\n').slice(0, FLOW_BODY_MAX);
}

/**
 * Falta un dato y hay Flow (nov 2026): se manda SOLO el Flow, sin la pregunta
 * ni las listas de chat — tres mensajes seguidos confundían. El pending / flujo
 * queda abierto: contestar por chat sigue funcionando. Con botones de DECISIÓN
 * del handler (reemplazar una campaña…) esos botones se respetan. `fallbackText`
 * lleva la pregunta original por si Meta rechaza el Flow.
 */
async function appendFlowOffer(
  items: BotResponseItem[],
  response: HandlerResponse,
  ctx: ChannelContext,
  offer: OfferForm,
  def: Definition,
  flowId: string,
  body: string,
  unavailable: () => void,
): Promise<void> {
  const asking = !offer.explicit && !response.interactive
    && !!(response.sideEffects?.setPendingActivity || response.sideEffects?.startFlow);
  const before = items.length;
  const flowBody = asking ? offerSummary(def, offer.prefill ?? {}, response.messages) : body;
  await appendMetaFlowOffer(items, response, ctx, offer, def, flowId, flowBody, unavailable);
  const added = items.length > before ? items[items.length - 1] : null;
  if (!asking || added?.interactive?.type !== 'flow') return;
  const replaced = items.slice(0, before);
  const question = replaced.map(i => i.text ?? i.interactive?.body ?? '').filter(Boolean);
  added.interactive.fallbackText = [...new Set(question)].join('\n\n');
  items.splice(0, before);
  console.log(`[FORM] pregunta de chat reemplazada por el Flow action=${offer.action} items=${before}`);
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
      // WHATSAPP_FLOW_ON_MISSING=false: cuando falta un dato se pregunta solo
      // por chat; el Flow queda para quien escribe "formulario".
      if (!offer.explicit && String((await getSetting('WHATSAPP_FLOW_ON_MISSING')) ?? '') === 'false') {
        console.log(`[FORM] offer implícita omitida (WHATSAPP_FLOW_ON_MISSING=false) action=${offer.action}`);
        return;
      }
      // TODO / FUTURE: Meta Flow implementation retained for future activation.
      await appendFlowOffer(items, response, ctx, offer, def, provider.flowId, body, unavailable);
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
    prefill: { ...(offer.prefill ?? {}), ...(await flowMarkerFor(Number(ctx.userId), response, offer.action)) },
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
