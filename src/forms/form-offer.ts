import { formSessionService } from '../services/form-session.service.js';
import { getSetting } from '../services/settings.service.js';
import { computeFormOptions } from './form-options.js';
import { FORM_DEFINITIONS } from './form-definitions.js';
import { resolveFormInitialValues } from './form-prefill.js';
import { initKey, optionsKey, isoToFlowDate, FIXED_GROUP_SLOTS } from './whatsapp-flow-generator.js';
import { getTodayISO } from '../utils/date.js';
import type { BotResponseItem, ChannelContext } from '../services/message-pipeline.js';
import type { HandlerResponse } from '../types/index.js';

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
    // Formularios por WhatsApp Flows (endpointless): se hornean las opciones
    // dinámicas en flow_action_payload.data. Gateado por el flow_id publicado
    // en Meta (settings grupo bot). Sin flow_id → sigue dark, no se ofrece.
    const flowId = ((await getSetting(def.settingKey)) as string) || '';
    if (!flowId) {
      console.log(`[FORM] skip offer (whatsapp): ${def.settingKey} vacío`);
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
    });
    const opts = await computeFormOptions(offer.action, Number(ctx.userId));
    const data: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.optionsSource) data[optionsKey(f.key)] = opts.lists[f.optionsSource] ?? [];
    }

    // Prellenado: lo que el usuario YA dijo en el chat no se le vuelve a pedir.
    // Misma resolución que usa el form web (form-prefill.ts, fuente única).
    // Flows exige que TODA clave declarada en el esquema de data venga en el
    // payload, así que las que no se resolvieron van como string vacío.
    const initial = resolveFormInitialValues({
      action: offer.action,
      prefill: offer.prefill ?? {},
      options: opts,
      todayISO: getTodayISO(),
    });
    const prefilled: string[] = [];
    for (const f of def.fields) {
      if (f.type === 'group') {
        for (let i = 1; i <= FIXED_GROUP_SLOTS; i++) {
          for (const sub of f.fields ?? []) data[initKey(`${f.key}_${i}_${sub.key}`)] = '';
        }
        continue;
      }
      if (f.allowOther) {
        const other = initial[`${f.key}_other`];
        data[initKey(`${f.key}_other`)] = typeof other === 'string' ? other : '';
        if (typeof other === 'string' && other) prefilled.push(`${f.key}_other`);
      }
      const v = initial[f.key];
      if (v === undefined || v === null || v === '') { data[initKey(f.key)] = ''; continue; }
      // El DatePicker (Flow JSON ≥5.0) toma 'YYYY-MM-DD'; isoToFlowDate solo valida.
      const encoded = f.type === 'date' ? (isoToFlowDate(String(v)) ?? '') : String(v);
      data[initKey(f.key)] = encoded;
      if (encoded) prefilled.push(f.key);
    }
    console.log(`[FORM] prefill (whatsapp) action=${offer.action} campos=[${prefilled.join(', ')}]`);
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
