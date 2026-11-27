// "compré 3 vacas y 5 terneros" sin lote: en vez de preguntar una por una, se
// ofrece UN formulario con las categorías precargadas, ANTES de que el compuesto
// arranque (invariante 7 intacta: no se frena a mitad, no empezó). La cola de
// preguntas queda abierta igual, así contestar por chat sigue funcionando.
import crypto from 'crypto';
import { getSetting } from '../services/settings.service.js';
import { findAllUserPlots } from '../services/expenses.js';
import { livestockLocationIntent } from '../utils/livestock-location-intent.js';
import { plotChoicePrompt } from '../domain/livestock/livestock.service.js';
import { resolveWhatsAppFormProvider } from './form-provider.js';
import { FORM_DEFINITIONS } from './form-definitions.js';
import { appendFormOffer } from './form-offer.js';
import { MAX_LIVESTOCK_ROWS } from './livestock-rows.js';
import type { BotResponseItem, ChannelContext } from '../services/message-pipeline.js';
import type { HandlerResponse, ParseResult } from '../types/index.js';

type Cmd = Record<string, unknown>;

/** Datos que el formulario no tiene o que no se pueden compartir entre filas. */
const UNSUPPORTED = ['plotName', 'fieldName', 'corralName', 'price_per_kg_ars', 'price_per_kg_usd',
  'total_weight_kg', 'avg_weight_kg', 'animal_ref', 'animal_refs', 'notes'];

function batchable(results: ParseResult[]): Cmd[] | null {
  if (results.length < 2 || results.length > MAX_LIVESTOCK_ROWS) return null;
  const cmds: Cmd[] = [];
  for (const r of results) {
    const data = r.intent.type === 'command' ? (r.intent.data as unknown as Cmd) : null;
    if (!data || data.command !== 'add_livestock' || !data.category || !(Number(data.count) > 0)) return null;
    if (UNSUPPORTED.some(k => data[k] !== undefined && data[k] !== null && data[k] !== '')) return null;
    cmds.push(data);
  }
  // Fecha y moneda son una sola para todo el formulario.
  const dates = new Set(cmds.map(c => c.eventDate ?? null));
  const usd = cmds.some(c => c.unit_price_usd);
  const ars = cmds.some(c => c.unit_price_ars);
  return dates.size === 1 && !(usd && ars) ? cmds : null;
}

export interface LivestockBatchOffer {
  items: BotResponseItem[];
  pending: Record<string, unknown>;
}

export async function offerLivestockBatch(
  results: ParseResult[],
  ctx: ChannelContext,
  text: string,
): Promise<LivestockBatchOffer | null> {
  if (ctx.channel !== 'whatsapp') return null;
  const cmds = batchable(results);
  if (!cmds) return null;
  const intent = livestockLocationIntent(text);
  if (intent === 'feedlot' || intent === 'ambiguous') return null;
  if ((await resolveWhatsAppFormProvider(FORM_DEFINITIONS.add_livestock)).kind !== 'meta_flow') return null;
  if (String((await getSetting('WHATSAPP_FLOW_ON_MISSING')) ?? '') === 'false') return null;
  const plots = (await findAllUserPlots(ctx.userId as never)) as Array<{ name: string; field_name: string }>;
  if (plots.length < 2) return null;

  const batch = crypto.randomBytes(6).toString('hex');
  const ask = (c: Cmd) => `👇 Alta de hacienda(${c.count} ${c.category}): ${plotChoicePrompt(plots)}`;
  const queued = (c: Cmd) => ({
    command: 'add_livestock', data: { ...c, __batch: batch, __fromQueue: true }, missing: ['plot'], askPrompt: ask(c),
  });
  const [first, ...rest] = cmds;
  const pending = { ...queued(first), nextInQueue: rest.map(queued) };

  const price = (c: Cmd) => c.unit_price_usd ?? c.unit_price_ars ?? null;
  const row = (c: Cmd) => ({ category: c.category, count: c.count, breed: c.breed ?? null, unit_price: price(c), isPurchase: c.isPurchase === true });
  const items: BotResponseItem[] = [{ type: 'text', text: ask(first) }];
  await appendFormOffer(items, {
    messages: [ask(first)],
    sideEffects: {
      setPendingActivity: pending,
      offerForm: {
        action: 'add_livestock',
        prefill: {
          ...row(first),
          currency: cmds.some(c => c.unit_price_usd) ? 'USD' : 'ARS',
          eventDate: first.eventDate ?? null,
          _rows: cmds.map(row),
          _batch: batch,
          _batchSize: cmds.length,
        },
      },
    },
  } as unknown as HandlerResponse, ctx);

  if (!items.some(i => i.interactive?.type === 'flow')) return null;
  console.log(`[INTERCEPT] alta de ${cmds.length} categorías sin lote → un formulario (la cola queda abierta)`);
  return { items, pending };
}
