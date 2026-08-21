import { formSessionService } from '../services/form-session.service.js';
import { getSetting } from '../services/settings.service.js';
import { computeFormOptions } from './form-options.js';
import { FORM_DEFINITIONS } from './form-definitions.js';
import type { BotResponseItem, ChannelContext } from '../services/message-pipeline.js';
import type { HandlerResponse } from '../types/index.js';

const ACTION_LABEL: Record<string, string> = {
  sow_crop: 'la siembra',
  harvest_crop: 'la cosecha',
};

const FLOW_ID_SETTING: Record<string, string> = {
  sow_crop: 'WHATSAPP_FLOW_ID_SOW',
  harvest_crop: 'WHATSAPP_FLOW_ID_HARVEST',
};

/** channel_id "crudo" por canal: telegram guarda tg_<chatId> en phone. */
function rawChannelId(ctx: ChannelContext): string {
  if (ctx.channel === 'telegram') return ctx.phone.replace(/^tg_/, '');
  return ctx.phone;
}

export async function appendFormOffer(
  items: BotResponseItem[],
  response: HandlerResponse,
  ctx: ChannelContext,
): Promise<void> {
  const offer = response.sideEffects?.offerForm;
  if (!offer) return;
  const body = `📝 Si preferís, cargá ${ACTION_LABEL[offer.action] ?? 'los datos'} con un formulario:`;

  if (ctx.channel === 'whatsapp') {
    // Formularios por WhatsApp Flows (endpointless): se hornean las opciones de
    // lote/cultivo en flow_action_payload.data. Gateado por el flow_id publicado
    // en Meta (settings grupo bot). Sin flow_id → sigue dark, no se ofrece.
    const flowId = ((await getSetting(FLOW_ID_SETTING[offer.action])) as string) || '';
    if (!flowId) {
      console.log(`[FORM] skip offer (whatsapp): ${FLOW_ID_SETTING[offer.action]} vacío`);
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
    });
    const opts = await computeFormOptions(offer.action, Number(ctx.userId));
    const plotOpts = opts.plots.map(p => ({ id: String(p.id), title: `${p.name} (${p.fieldName})` }));
    const cropOpts = opts.crops.map(c => ({ id: c, title: c }));
    const data: Record<string, unknown> = {};
    for (const f of FORM_DEFINITIONS[offer.action].fields) {
      if (f.optionsSource === 'plots') data[`${f.key}_options`] = plotOpts;
      if (f.optionsSource === 'crops') data[`${f.key}_options`] = cropOpts;
    }
    const mode = (((await getSetting('WHATSAPP_FLOW_MODE')) as string) || 'published') === 'draft' ? 'draft' : 'published';
    items.push({
      type: 'interactive',
      interactive: {
        type: 'flow',
        body,
        flow: { flowId, flowToken: token, cta: 'Abrir formulario', mode, data },
      },
    });
    console.log(`[FORM] offer flow (whatsapp) action=${offer.action} mode=${mode}`);
    return;
  }

  const publicUrl = ((await getSetting('PUBLIC_URL')) as string) || '';
  if (!publicUrl) {
    console.log('[FORM] skip offer: PUBLIC_URL vacío');
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
