// TODO / FUTURE: Meta Flow implementation retained for future activation.
//
// Oferta de formulario por WhatsApp Flows (endpointless). Es EXACTAMENTE la
// rama WhatsApp que vivía en form-offer.ts, movida acá sin cambios de
// comportamiento cuando Meta todavía no aprobaba los Flows de la cuenta
// (Sep 2026). Hoy WhatsApp usa el colector conversacional; este renderer se
// usa solo con WHATSAPP_FORM_PROVIDER=meta_flow + el flow_id publicado (ver
// form-provider.ts y docs/features/forms.md § "Reactivar WhatsApp Flows").
//
// Contrato: las opciones dinámicas se hornean en flow_action_payload.data y el
// nfm_reply vuelve por whatsapp.controller → submitForm(..., {flowResponse}).
import { formSessionService } from '../services/form-session.service.js';
import { getSetting } from '../services/settings.service.js';
import { computeFormOptions } from './form-options.js';
import type { FormDefinition } from './form-definitions.js';
import { resolveFormInitialValues } from './form-prefill.js';
import { initKey, optionsKey, isoToFlowDate, FIXED_GROUP_SLOTS, validateFlowData } from './whatsapp-flow-generator.js';
import { getTodayISO } from '../utils/date.js';
import type { BotResponseItem, ChannelContext } from '../services/message-pipeline.js';
import type { HandlerResponse } from '../types/index.js';

type OfferForm = NonNullable<NonNullable<HandlerResponse['sideEffects']>['offerForm']>;

export async function appendMetaFlowOffer(
  items: BotResponseItem[],
  response: HandlerResponse,
  ctx: ChannelContext,
  offer: OfferForm,
  def: FormDefinition,
  flowId: string,
  body: string,
  unavailable: () => void,
): Promise<void> {
  const opts = await computeFormOptions(offer.action, Number(ctx.userId));

  // Gap B — un select REQUERIDO sin opciones deja al usuario trabado: abre el
  // Flow pero no puede enviar (ej. alta de hacienda sin lotes ni corrales →
  // location_options vacío). No se manda el Flow: se loguea y, si lo pidió
  // explícito, se avisa por texto (nunca un formulario que no se puede cerrar).
  for (const f of def.fields) {
    if (f.required && f.optionsSource && (opts.lists[f.optionsSource] ?? []).length === 0) {
      console.error(`[FORM] skip offer (whatsapp): opciones vacías para el campo requerido "${f.key}" (${f.optionsSource}) action=${offer.action}`);
      unavailable();
      return;
    }
  }

  const token = await formSessionService.create({
    userId: Number(ctx.userId),
    action: offer.action,
    prefill: offer.prefill ?? {},
    channel: ctx.channel,
    channelId: ctx.phone,
    phone: ctx.phone,
    hadPending: !!response.sideEffects?.setPendingActivity,
    mode: 'flow',
  });
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

  // Gap C — antes de enviar, verificar que estén TODAS las claves de data y que
  // ningún valor sea null/numérico (un solo faltante y el Flow no abre en el
  // celular). Falla ruidoso fuera de prod; en prod se loguea y no se manda un
  // Flow roto (invariante 1: nunca en silencio).
  const check = validateFlowData(def, data);
  if (!check.ok) {
    const msg = `[FORM] flow data inválida (whatsapp) action=${offer.action}: ${check.errors.join('; ')}`;
    console.error(msg);
    if (process.env.NODE_ENV !== 'production') throw new Error(msg);
    unavailable();
    return;
  }

  // Gap A — `mode: draft` solo llega a los números de prueba de la app de Meta;
  // un Flow ya publicado va SIN la clave `mode` (Meta rechaza `mode: published`).
  // Default draft: mientras el Flow no esté publicado, la clave viaja.
  const modeSetting = String((await getSetting('WHATSAPP_FLOW_MODE')) || 'draft').toLowerCase();
  const mode = modeSetting === 'draft' ? 'draft' : undefined;
  items.push({
    type: 'interactive',
    interactive: {
      type: 'flow',
      body,
      flow: { flowId, flowToken: token, cta: 'Abrir formulario', ...(mode ? { mode } : {}), data },
    },
  });
  console.log(`[FORM] offer flow (whatsapp) action=${offer.action} mode=${mode ?? 'published (clave omitida)'}`);
}
