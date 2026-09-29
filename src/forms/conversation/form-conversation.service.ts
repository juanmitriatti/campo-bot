// Colector CONVERSACIONAL de formularios (WhatsApp sin Flows, Sep 2026).
//
// No es un segundo chatbot: es una rama más del pipeline (message-pipeline.ts)
// que, con un formulario abierto, junta los datos que faltan por chat. Las
// reglas son las de la FormDefinition (form-definitions.ts) y la persistencia
// es la de siempre: al confirmar entra por submitForm → prepareSubmission →
// DomainRouter.routeCommand, igual que el form web y el Flow. Claude no
// participa: la extracción es determinística y el backend valida todo.
//
// Estado:
//   - DRAFT durable en form_sessions (mode='conversation'): cada respuesta
//     válida se persiste al toque, con vencimiento DESLIZANTE
//     (FORM_CONVERSATION_DRAFT_TTL_HOURS, default 24 h). Un restart, un error o
//     un cambio de tema no pierden lo cargado.
//   - PUNTERO de ruteo en un TypedPendingStore (30 min, invariante 10): dice
//     "el próximo mensaje de este usuario es para este formulario". Si vence,
//     el draft sigue y se entra con «retomar».
//
// Prioridad en el pipeline: formulario activo > flow > pending > tarjeta de
// confirmación > agente. Un solo colector activo por usuario.
import { TypedPendingStore } from '../../middleware/typed-pending-store.js';
import {
  formSessionService, type FormConversationStatus, type FormSessionRow,
} from '../../services/form-session.service.js';
import { getSettingNumber } from '../../services/settings.service.js';
import {
  FORM_DEFINITIONS, crossCheckIssues, validateFieldValue,
  type FormAction, type FormDefinition, type FormField, type FormOption,
} from '../form-definitions.js';
import { computeFormOptions, type FormOptions } from '../form-options.js';
import { resolveFormInitialValues } from '../form-prefill.js';
import { FORM_PRESENTATION, type FormPresentation } from './presentation.js';
import { extractFieldValues, isFieldEmpty } from './field-extractor.js';
import {
  cbId, parseCbId, renderEditMenu, renderQuestion, renderRecap, renderSummary,
} from './renderer.js';
import {
  hasActionVerb, isAffirmation, isReadOnlyQuery, looksLikeNewActionOrQuery,
} from '../../middleware/conversation-guards.js';
import {
  RESUME_FORM_RE, isFormCancel, isSkipAnswer, matchesFormDomainVerb, normLex,
} from '../../utils/lexicon.js';
import { getTodayISO } from '../../utils/date.js';
import type { BotResponseItem, ChannelContext } from '../../services/message-pipeline.js';
import type { HandlerResponse } from '../../types/index.js';

export interface FormPointer { token: string; action: FormAction }

/** "El próximo mensaje de este usuario es para este formulario." */
export const formConversationStore = new TypedPendingStore<FormPointer>('form_conversation');

/** Lo que el colector necesita del pipeline (inyectado: evita el ciclo de imports). */
export interface FormConversationDeps {
  collectResponse(r: HandlerResponse): BotResponseItem[];
  /** Procesa el texto por el pipeline normal (consulta / acción nueva). */
  processRest(text: string): Promise<BotResponseItem[]>;
  /** Comando regex (sin IA) del texto, si hay. */
  parseCommandOnly(text: string): { command: string } | null;
  /** Comandos read-only que se contestan sin abandonar lo abierto. */
  readOnlyCommands: ReadonlySet<string>;
  /** ¿Quedó otro colector abierto (flow / pending / tarjeta) tras processRest? */
  hasOtherCollector(): Promise<boolean>;
}

const AWAIT_CONFIRM = '__confirm';
const AWAIT_EDIT = '__edit';

interface Draft {
  values: Record<string, unknown>;
  /** Valores que puso el sistema, no el usuario (fecha de hoy, moneda, lote único). */
  autoFilled: string[];
  /** Opcionales ya ofrecidos (respondidos u omitidos): no se vuelven a preguntar. */
  asked: string[];
  /** Re-preguntas sin progreso por campo (escalera, invariante 6). */
  attempts: Record<string, number>;
  /** Opciones mostradas en la última pregunta (taps y "2"). */
  choices: { field: string; ids: string[] } | null;
  /** Campo que se está corrigiendo desde el resumen. */
  editing: string | null;
}

interface Session {
  token: string;
  userId: number;
  action: FormAction;
  def: FormDefinition;
  pres: FormPresentation;
  draft: Draft;
  status: FormConversationStatus;
  awaiting: string | null;
  options: FormOptions;
  todayISO: string;
}

async function ttlHours(): Promise<number> {
  const n = Number(await getSettingNumber('FORM_CONVERSATION_DRAFT_TTL_HOURS'));
  return Number.isFinite(n) && n >= 1 ? n : 24;
}

function emptyDraft(): Draft {
  return { values: {}, autoFilled: [], asked: [], attempts: {}, choices: null, editing: null };
}

function parseDraft(raw: unknown): Draft {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<Draft>;
  return {
    values: (d.values && typeof d.values === 'object') ? { ...d.values } : {},
    autoFilled: Array.isArray(d.autoFilled) ? [...d.autoFilled] : [],
    asked: Array.isArray(d.asked) ? [...d.asked] : [],
    attempts: (d.attempts && typeof d.attempts === 'object') ? { ...d.attempts } : {},
    choices: d.choices ?? null,
    editing: d.editing ?? null,
  };
}

async function hydrateSession(row: FormSessionRow): Promise<Session | null> {
  const action = row.action as FormAction;
  const def = FORM_DEFINITIONS[action];
  if (!def) return null;
  return {
    token: row.token,
    userId: Number(row.user_id),
    action,
    def,
    pres: FORM_PRESENTATION[action],
    draft: parseDraft(row.draft),
    status: (row.status ?? 'collecting') as FormConversationStatus,
    awaiting: row.awaiting_field ?? null,
    options: await computeFormOptions(action, Number(row.user_id)),
    todayISO: getTodayISO(),
  };
}

async function persist(s: Session): Promise<boolean> {
  const ok = await formSessionService.saveConversation(
    s.token, s.userId,
    { draft: s.draft as unknown as Record<string, unknown>, status: s.status, awaitingField: s.awaiting },
    await ttlHours(),
  );
  if (!ok) console.warn(`[FORM] conversation save falló (sesión ya no viva) token=${s.token.slice(0, 8)}`);
  return ok;
}

function fieldByKey(def: FormDefinition, key: string | null): FormField | undefined {
  return key ? def.fields.find(f => f.key === key) : undefined;
}

function cleanValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

function requiredMissing(s: Session): FormField[] {
  return s.def.fields.filter(f => f.required && isFieldEmpty(s.draft.values, f));
}

function nounLabel(s: Session): string {
  return s.pres.noun.replace(/^(la|el) /, '');
}

function formOpenId(action: FormAction): string {
  return ({
    sow_crop: 'form_open_sow', harvest_crop: 'form_open_harvest', log_expense: 'form_open_expense',
    log_income: 'form_open_income', log_activity: 'form_open_activity', add_livestock: 'form_open_livestock',
  } as const)[action];
}

/** Aviso de draft vencido: nunca reutiliza datos viejos. */
export function expiredItems(action: FormAction): BotResponseItem[] {
  const noun = FORM_PRESENTATION[action]?.noun ?? 'el formulario';
  console.log(`[FORM] expired action=${action}`);
  return [{
    type: 'interactive',
    interactive: {
      type: 'buttons',
      body: `⌛ El formulario de ${noun.replace(/^(la|el) /, '')} que empezaste venció y no guardé nada. ¿Empezamos uno nuevo?`,
      buttons: [{ id: formOpenId(action), title: '📝 Nuevo formulario' }],
    },
  }];
}

// ─── Aplicar valores ─────────────────────────────────────────────────────

interface ApplyResult { applied: string[]; rejected: Array<{ field: string; error: string }> }

/**
 * Valida cada candidato con la MISMA función que el submit
 * (validateFieldValue) y solo guarda lo válido. `null` = limpiar el campo.
 */
function applyCandidates(s: Session, cands: Record<string, unknown>): ApplyResult {
  const res: ApplyResult = { applied: [], rejected: [] };
  const v = s.draft.values;
  const touched = (key: string) => {
    if (!res.applied.includes(key)) res.applied.push(key);
    s.draft.autoFilled = s.draft.autoFilled.filter(k => k !== key);
    delete s.draft.attempts[key];
  };
  for (const [key, raw] of Object.entries(cands)) {
    if (key.endsWith('_other')) {
      const base = key.slice(0, -'_other'.length);
      const f = fieldByKey(s.def, base);
      if (!f?.allowOther) continue;
      if (raw === null) { delete v[key]; continue; }
      const text = String(raw).trim().slice(0, 60);
      if (!text) continue;
      v[key] = text;
      delete v[base];
      touched(base);
      continue;
    }
    const f = fieldByKey(s.def, key);
    if (!f) continue;
    if (raw === null) { delete v[key]; continue; }
    if (f.type === 'group') {
      const items: Record<string, unknown>[] = [];
      for (const [i, item] of (raw as Record<string, unknown>[]).slice(0, f.maxItems ?? 50).entries()) {
        const out: Record<string, unknown> = {};
        let bad: string | null = null;
        for (const sub of f.fields ?? []) {
          const r = validateFieldValue(sub, item[sub.key], s.todayISO, `Camión ${i + 1}: ${sub.label.toLowerCase()}`);
          if (r.error) { bad = r.error; break; }
          if (r.value !== undefined) out[sub.key] = r.value;
        }
        if (bad) res.rejected.push({ field: key, error: bad });
        else items.push(out);
      }
      if (items.length > 0) { v[key] = items; touched(key); }
      continue;
    }
    const r = validateFieldValue(f, raw, s.todayISO);
    if (r.error) { res.rejected.push({ field: key, error: r.error }); continue; }
    if (r.value === undefined) continue;
    v[key] = r.value;
    if (f.allowOther) delete v[`${key}_other`];
    touched(key);
  }
  return res;
}

// ─── Avanzar ─────────────────────────────────────────────────────────────

async function ask(
  s: Session,
  field: FormField,
  opts: { notes?: string[]; reason?: string | null; candidates?: FormOption[] } = {},
): Promise<BotResponseItem[]> {
  const missing = requiredMissing(s);
  const hasData = Object.keys(cleanValues(s.draft.values)).some(k => !s.draft.autoFilled.includes(k));
  const r = renderQuestion({
    def: s.def,
    pres: s.pres,
    field,
    options: s.options,
    token: s.token,
    todayISO: s.todayISO,
    notes: opts.notes,
    reason: opts.reason,
    candidates: opts.candidates,
    onlyMissing: field.required && missing.length === 1 && missing[0].key === field.key && hasData && !opts.reason,
    escalate: (s.draft.attempts[field.key] ?? 0) >= 2,
    skippable: !field.required,
  });
  s.status = 'collecting';
  s.awaiting = field.key;
  s.draft.choices = r.choices;
  if (!(await persist(s))) return expiredItems(s.action);
  return r.items;
}

async function showSummary(s: Session, notes: string[] = []): Promise<BotResponseItem[]> {
  s.status = 'confirming';
  s.awaiting = AWAIT_CONFIRM;
  s.draft.choices = null;
  s.draft.editing = null;
  if (!(await persist(s))) return expiredItems(s.action);
  console.log(`[FORM] conversation summary action=${s.action} token=${s.token.slice(0, 8)}`);
  return renderSummary({
    def: s.def, pres: s.pres, values: s.draft.values, options: s.options, token: s.token, todayISO: s.todayISO, notes,
  });
}

/**
 * Decide el próximo paso: obligatorio que falta → requerido condicional del
 * crossCheck → opcional "offer" no ofrecido → pre-validación del submit
 * (ownership, allow-list, cultivo activo) → resumen. Un resumen nunca promete
 * algo que el submit después rechaza.
 */
async function advance(s: Session, notes: string[] = []): Promise<BotResponseItem[]> {
  s.draft.editing = null;
  const missing = requiredMissing(s);
  if (missing.length > 0) return ask(s, missing[0], { notes });

  const issue = crossCheckIssues(s.def, cleanValues(s.draft.values)).find(i => i.field);
  if (issue?.field) {
    const f = fieldByKey(s.def, issue.field);
    if (f) return ask(s, f, { notes, reason: `🤔 ${issue.message}` });
  }

  const offer = s.def.fields.find(f =>
    !f.required && s.pres.fields[f.key]?.optional === 'offer'
    && isFieldEmpty(s.draft.values, f) && !s.draft.asked.includes(f.key));
  if (offer) {
    s.draft.asked.push(offer.key);
    return ask(s, offer, { notes });
  }

  const { prepareSubmission } = await import('../form-submit.service.js');
  const prep = await prepareSubmission(s.userId, s.action, cleanValues(s.draft.values));
  if (!prep.ok) {
    const f = fieldByKey(s.def, prep.field ?? null);
    if (f) {
      delete s.draft.values[f.key];
      delete s.draft.values[`${f.key}_other`];
      console.log(`[FORM] conversation preflight rechazó ${f.key}: ${prep.error.slice(0, 80)}`);
      return ask(s, f, { notes, reason: `🤔 ${prep.error}` });
    }
    return showSummary(s, [...notes, `⚠️ ${prep.error}`]);
  }
  return showSummary(s, notes);
}

/** Vuelve a mostrar exactamente lo que está abierto (sin avanzar). */
async function reprompt(s: Session, notes: string[] = []): Promise<BotResponseItem[]> {
  if (s.awaiting === AWAIT_CONFIRM) return showSummary(s, notes);
  if (s.awaiting === AWAIT_EDIT) {
    return [...notes.map(t => ({ type: 'text' as const, text: t })), ...renderEditMenu({
      def: s.def, pres: s.pres, values: s.draft.values, options: s.options, token: s.token, todayISO: s.todayISO,
    })];
  }
  const f = fieldByKey(s.def, s.awaiting);
  if (f) return ask(s, f, { notes });
  return advance(s, notes);
}

// ─── Iniciar / retomar / estacionar ──────────────────────────────────────

function refreshAutoDate(s: Session): void {
  if (s.draft.autoFilled.includes('event_date') && s.draft.values.event_date !== s.todayISO) {
    s.draft.values.event_date = s.todayISO;
    console.log(`[FORM] fecha auto recalculada a hoy token=${s.token.slice(0, 8)}`);
  }
}

async function parkActive(ctx: ChannelContext, exceptToken?: string): Promise<BotResponseItem[]> {
  const ptr = formConversationStore.get(ctx.phone);
  if (!ptr || ptr.token === exceptToken) return [];
  formConversationStore.clear(ctx.phone);
  const ok = await formSessionService.setConversationStatus(ptr.token, Number(ctx.userId), 'parked');
  if (!ok) return [];
  const noun = FORM_PRESENTATION[ptr.action]?.noun ?? 'el formulario';
  console.log(`[FORM] conversation parked action=${ptr.action} token=${ptr.token.slice(0, 8)}`);
  return [{ type: 'text', text: `💡 Dejé ${noun} a medio cargar. Escribí *retomar* cuando quieras seguir.` }];
}

async function activate(ctx: ChannelContext, s: Session): Promise<void> {
  formConversationStore.set(ctx.phone, { token: s.token, action: s.action });
}

export async function startConversationForm(
  ctx: ChannelContext,
  offer: { action: FormAction; prefill?: Record<string, unknown> },
  opts: { hadPending?: boolean; forceNew?: boolean } = {},
): Promise<BotResponseItem[]> {
  const userId = Number(ctx.userId);
  const def = FORM_DEFINITIONS[offer.action];
  const pres = FORM_PRESENTATION[offer.action];
  if (!def || !pres) return [];

  // Ya hay uno a medio cargar de la misma acción → retomar o empezar de cero
  // (nunca dos drafts del mismo tipo peleando por los mismos mensajes).
  if (!opts.forceNew) {
    const existing = await formSessionService.findResumable(userId, offer.action);
    if (existing) {
      const s = await hydrateSession(existing);
      if (s) {
        const recap = renderRecap(s.def, s.pres, s.draft.values, s.options, s.todayISO);
        const parked = await parkActive(ctx, s.token);
        return [...parked, {
          type: 'interactive',
          interactive: {
            type: 'buttons',
            body: `📝 Tenés ${pres.noun} a medio cargar${recap ? ` (${recap})` : ''}. ¿Lo retomamos o empezamos de cero?`,
            buttons: [
              { id: cbId(s.token, 'resume'), title: '↩️ Retomar' },
              { id: cbId(s.token, 'restart'), title: '🆕 Empezar de nuevo' },
            ],
          },
        }];
      }
    }
  }

  const parked = await parkActive(ctx);
  const options = await computeFormOptions(offer.action, userId);
  const todayISO = getTodayISO();
  const prefill = offer.prefill ?? {};
  const initial = resolveFormInitialValues({ action: offer.action, prefill, options, todayISO });

  const draft = emptyDraft();
  const s: Session = {
    token: '', userId, action: offer.action, def, pres, draft,
    status: 'collecting', awaiting: null, options, todayISO,
  };
  applyCandidates(s, initial);
  // Lo que puso el sistema y no el usuario: se muestra en el resumen, se puede
  // editar, y la fecha se recalcula si se retoma otro día.
  if (draft.values.event_date && !(typeof prefill.eventDate === 'string' && prefill.eventDate)) draft.autoFilled.push('event_date');
  if (draft.values.plot_id && !prefill.plotName) draft.autoFilled.push('plot_id');
  const currency = fieldByKey(def, 'currency');
  if (currency?.required && isFieldEmpty(draft.values, currency)) {
    draft.values.currency = 'ARS';
    draft.autoFilled.push('currency');
  }

  s.token = await formSessionService.createConversation({
    userId,
    action: offer.action,
    prefill,
    draft: draft as unknown as Record<string, unknown>,
    channel: ctx.channel,
    channelId: ctx.channel === 'telegram' ? ctx.phone.replace(/^tg_/, '') : ctx.phone,
    phone: ctx.phone,
    hadPending: !!opts.hadPending,
    ttlHours: await ttlHours(),
  });
  await activate(ctx, s);
  console.log(`[FORM] conversation start action=${offer.action} prefilled=[${Object.keys(cleanValues(draft.values)).join(', ')}]`);
  const intro = `📝 Vamos con ${pres.noun}. Si querés, mandame todo junto (ej: ${exampleFor(offer.action)}).`;
  const next = await advance(s);
  return [...parked, { type: 'text', text: intro }, ...next];
}

function exampleFor(action: FormAction): string {
  switch (action) {
    case 'log_expense': return '_250 mil de combustible en el lote A1, hoy_';
    case 'log_income': return '_1,5 palos de venta de soja, ayer_';
    case 'sow_crop': return '_soja en el lote Norte, hoy_';
    case 'harvest_crop': return '_lote Norte, 3500 kg/ha, ayer_';
    case 'log_activity': return '_fumigué el lote Norte con glifosato 2 lt/ha_';
    case 'add_livestock': return '_40 terneros en el lote Sur_';
  }
}

/** "Retomar" / "volvamos al gasto" (comando resume_form o tap). */
export async function resumeConversationForm(
  ctx: ChannelContext,
  action: FormAction | null,
  specificToken?: string,
): Promise<BotResponseItem[]> {
  const userId = Number(ctx.userId);
  const row = specificToken
    ? await formSessionService.getLiveConversation(specificToken, userId)
    : await formSessionService.findResumable(userId, action);
  if (!row) {
    const expired = await formSessionService.findRecentlyExpired(userId, action);
    if (expired) return expiredItems(expired.action as FormAction);
    return [{ type: 'text', text: '📝 No tenés ningún formulario a medio cargar. Escribí *formulario* para empezar uno.' }];
  }
  const s = await hydrateSession(row);
  if (!s) return [];
  const parked = await parkActive(ctx, s.token);
  refreshAutoDate(s);
  s.status = s.awaiting === AWAIT_CONFIRM ? 'confirming' : 'collecting';
  await activate(ctx, s);
  const recap = renderRecap(s.def, s.pres, s.draft.values, s.options, s.todayISO);
  console.log(`[FORM] conversation resume action=${s.action} token=${s.token.slice(0, 8)}`);
  const head = `↩️ Sigamos con ${s.pres.noun} que habías empezado${recap ? `: ${recap}` : ''}.`;
  return [...parked, { type: 'text', text: head }, ...(await reprompt(s))];
}

async function cancel(ctx: ChannelContext, s: Session): Promise<BotResponseItem[]> {
  formConversationStore.clear(ctx.phone);
  await formSessionService.setConversationStatus(s.token, s.userId, 'cancelled');
  console.log(`[FORM] conversation cancelled action=${s.action} token=${s.token.slice(0, 8)}`);
  return [{ type: 'text', text: `❌ Listo, descarté ${s.pres.noun}. No guardé nada.` }];
}

async function park(ctx: ChannelContext, s: Session): Promise<BotResponseItem> {
  formConversationStore.clear(ctx.phone);
  s.status = 'parked';
  await persist(s);
  const missing = requiredMissing(s).map(f => f.label.toLowerCase());
  console.log(`[FORM] conversation parked (pivot) action=${s.action} token=${s.token.slice(0, 8)}`);
  return {
    type: 'text',
    text: `💡 Dejé ${s.pres.noun} a medio cargar${missing.length ? ` (falta: ${missing.join(', ')})` : ''}. Escribí *retomar* cuando quieras seguir.`,
  };
}

// ─── Confirmar ───────────────────────────────────────────────────────────

async function confirm(ctx: ChannelContext, s: Session, deps: FormConversationDeps): Promise<BotResponseItem[]> {
  const { submitForm } = await import('../form-submit.service.js');
  // Ya estamos dentro del lock del usuario (el controller lo tomó): el submit
  // no lo vuelve a pedir (el lock no es reentrante).
  const result = await submitForm(s.token, cleanValues(s.draft.values), {
    deliver: 'return', userId: s.userId, alreadyLocked: true,
  });
  if (result.ok) {
    formConversationStore.clear(ctx.phone);
    console.log(`[FORM] conversation confirmed action=${s.action} token=${s.token.slice(0, 8)}`);
    return result.response ? deps.collectResponse(result.response) : [{ type: 'text', text: result.message }];
  }
  if (result.status === 409) {
    formConversationStore.clear(ctx.phone);
    return [{ type: 'text', text: result.error }];
  }
  if (result.status === 404) {
    formConversationStore.clear(ctx.phone);
    return expiredItems(s.action);
  }
  // 422: el dato culpable se vuelve a preguntar; el resto del draft se conserva.
  const f = fieldByKey(s.def, result.field ?? null);
  if (f) {
    delete s.draft.values[f.key];
    delete s.draft.values[`${f.key}_other`];
    return ask(s, f, { reason: `🤔 ${result.error}` });
  }
  return showSummary(s, [`⚠️ No lo pude guardar: ${result.error}`, 'Corregí lo que haga falta con ✏️ Editar, o escribí *cancelar*.']);
}

// ─── Mensajes de texto con un formulario abierto ─────────────────────────

async function loadActive(ctx: ChannelContext): Promise<{ ptr: FormPointer; s: Session | null } | null> {
  const ptr = formConversationStore.get(ctx.phone);
  if (!ptr) return null;
  const row = await formSessionService.getLiveConversation(ptr.token, Number(ctx.userId));
  return { ptr, s: row ? await hydrateSession(row) : null };
}

/**
 * Procesa un mensaje con un formulario abierto. null = no había formulario
 * abierto para este usuario (el pipeline sigue normal).
 */
export async function handleFormText(
  text: string,
  ctx: ChannelContext,
  deps: FormConversationDeps,
): Promise<BotResponseItem[] | null> {
  const loaded = await loadActive(ctx);
  if (!loaded) return null;
  const { ptr } = loaded;
  const s = loaded.s;

  // Puntero a una sesión que ya no está viva (vencida / confirmada / cancelada).
  if (!s) {
    formConversationStore.clear(ctx.phone);
    const row = await formSessionService.getConversation(ptr.token, Number(ctx.userId));
    const expired = !!row && !row.used_at && row.status !== 'cancelled' && new Date(row.expires_at).getTime() <= Date.now();
    if (!expired) return null;
    const notice = expiredItems(ptr.action);
    // El mensaje podía ser una acción nueva: se procesa igual (nunca se pierde).
    if (looksLikeNewActionOrQuery(text)) return [...notice, ...(await deps.processRest(text))];
    return notice;
  }

  refreshAutoDate(s);
  const t = normLex(text).trim();
  const awaitedField = fieldByKey(s.def, s.awaiting);

  if (isFormCancel(text)) return cancel(ctx, s);

  if (RESUME_FORM_RE.test(t)) return reprompt(s);

  if (s.awaiting === AWAIT_CONFIRM) {
    if (isAffirmation(text)) return confirm(ctx, s, deps);
    if (/^no\b/.test(t) && t.split(/\s+/).length <= 2) {
      s.awaiting = AWAIT_EDIT;
      await persist(s);
      return reprompt(s);
    }
  }

  if (s.awaiting === AWAIT_EDIT) {
    const idx = /^\d{1,2}$/.test(t) ? Number(t) - 1 : s.def.fields.findIndex(f => normLex(f.label) === t);
    const f = idx >= 0 ? s.def.fields[idx] : undefined;
    if (f) return startEditing(s, f);
  }

  if (awaitedField && isSkipAnswer(text)) {
    if (!awaitedField.required) return skipField(s, awaitedField);
    s.draft.attempts[awaitedField.key] = (s.draft.attempts[awaitedField.key] ?? 0) + 1;
    return ask(s, awaitedField, { reason: `🙏 ${awaitedField.label} es obligatorio para registrar ${s.pres.noun}.` });
  }

  // ¿Es respuesta, consulta o cambio de tema?
  const readOnlyCmd = deps.parseCommandOnly(text);
  const readOnlyCmdHit = !!readOnlyCmd && deps.readOnlyCommands.has(readOnlyCmd.command);
  const readOnly = isReadOnlyQuery(text) || readOnlyCmdHit;
  const otherDomainAction = hasActionVerb(text) && !matchesFormDomainVerb(s.action, text) && !isReadOnlyQuery(text);
  if (otherDomainAction) return pivot(ctx, s, text, deps);

  const overwrite = s.awaiting === AWAIT_CONFIRM || s.awaiting === AWAIT_EDIT || !!s.draft.editing;
  // Lo que puso el sistema (fecha de hoy, moneda, lote único) cuenta como
  // vacío: "…, ayer" tiene que pisar el "hoy" automático.
  const userValues = Object.fromEntries(
    Object.entries(s.draft.values).filter(([k]) => !s.draft.autoFilled.includes(k)),
  );
  const ex = extractFieldValues(text, {
    def: s.def,
    options: s.options,
    values: userValues,
    awaiting: awaitedField ? awaitedField.key : null,
    overwrite,
    todayISO: s.todayISO,
    choices: s.draft.choices,
    strict: readOnlyCmdHit,
  });
  const hasValues = Object.keys(ex.values).length > 0;

  if (hasValues || ex.ambiguous) {
    const before = JSON.stringify(s.draft.values);
    const r = applyCandidates(s, ex.values);
    const notes: string[] = [];
    if (overwrite && r.applied.length > 0 && JSON.stringify(s.draft.values) !== before) {
      notes.push(`✏️ Actualicé: ${r.applied.map(k => fieldByKey(s.def, k)?.label ?? k).join(', ')}.`);
    }
    for (const w of ex.warnings ?? []) notes.push(`⚠️ ${w}`);
    const rejected = r.rejected[0];
    if (rejected) {
      const f = fieldByKey(s.def, rejected.field)!;
      s.draft.attempts[f.key] = (s.draft.attempts[f.key] ?? 0) + 1;
      console.log(`[INTERCEPT] form no-progress field=${f.key} motivo="${rejected.error}"`);
      return ask(s, f, { notes, reason: `🤔 ${rejected.error}` });
    }
    if (ex.ambiguous) {
      const f = fieldByKey(s.def, ex.ambiguous.field)!;
      return ask(s, f, { notes, reason: ex.ambiguous.message, candidates: ex.ambiguous.candidates });
    }
    if (awaitedField && !r.applied.includes(awaitedField.key) && isFieldEmpty(s.draft.values, awaitedField)) {
      // Llenó otros datos pero no el que se preguntó: se vuelve a preguntar ese.
      return ask(s, awaitedField, { notes });
    }
    return advance(s, notes);
  }

  // Nada del formulario en el mensaje.
  if (readOnly) return answerQueryAndReprompt(ctx, s, ptr, text, deps);
  if (looksLikeNewActionOrQuery(text) || (readOnlyCmd && !deps.readOnlyCommands.has(readOnlyCmd.command))) {
    return pivot(ctx, s, text, deps);
  }

  if (s.awaiting === AWAIT_CONFIRM) {
    return showSummary(s, ['🤔 No te entendí. Tocá *✅ Confirmar* para guardar, *✏️ Editar* para cambiar algo o *❌ Cancelar*.']);
  }
  if (awaitedField) {
    s.draft.attempts[awaitedField.key] = (s.draft.attempts[awaitedField.key] ?? 0) + 1;
    console.log(`[INTERCEPT] form no-progress field=${awaitedField.key} texto="${text.slice(0, 60)}"`);
    return ask(s, awaitedField, { reason: ex.notFound?.message ?? '🤔 No te entendí.' });
  }
  return reprompt(s);
}

async function skipField(s: Session, f: FormField): Promise<BotResponseItem[]> {
  delete s.draft.values[f.key];
  delete s.draft.values[`${f.key}_other`];
  if (!s.draft.asked.includes(f.key)) s.draft.asked.push(f.key);
  console.log(`[FORM] opcional omitido field=${f.key}`);
  return advance(s);
}

async function startEditing(s: Session, f: FormField): Promise<BotResponseItem[]> {
  s.draft.editing = f.key;
  s.status = 'collecting';
  return ask(s, f);
}

async function answerQueryAndReprompt(
  ctx: ChannelContext, s: Session, ptr: FormPointer, text: string, deps: FormConversationDeps,
): Promise<BotResponseItem[]> {
  console.log(`[INTERCEPT] consulta con formulario ${s.action} abierto: respondo y re-pregunto`);
  formConversationStore.clear(ctx.phone);
  const rest = await deps.processRest(text);
  // Si la consulta abrió OTRO colector (o se inició/retomó otro formulario),
  // el formulario queda estacionado: nunca dos preguntas abiertas.
  if (formConversationStore.get(ctx.phone) || (await deps.hasOtherCollector())) {
    return [...rest, await park(ctx, s)];
  }
  formConversationStore.set(ctx.phone, ptr);
  return [...rest, ...(await reprompt(s))];
}

async function pivot(ctx: ChannelContext, s: Session, text: string, deps: FormConversationDeps): Promise<BotResponseItem[]> {
  const notice = await park(ctx, s);
  return [notice, ...(await deps.processRest(text))];
}

// ─── Taps ────────────────────────────────────────────────────────────────

/** Taps `cform_*`. null = no era un tap de formulario conversacional. */
export async function handleFormTap(
  callbackId: string,
  ctx: ChannelContext,
  deps: FormConversationDeps,
): Promise<BotResponseItem[] | null> {
  const parsed = parseCbId(callbackId);
  if (!parsed) return null;
  const userId = Number(ctx.userId);

  // Resolver la sesión SOLO entre las del usuario que tapeó (anti-IDOR).
  const ptr = formConversationStore.get(ctx.phone);
  let row: FormSessionRow | null = null;
  if (ptr && ptr.token.startsWith(parsed.tok8)) row = await formSessionService.getConversation(ptr.token, userId);
  if (!row) row = await formSessionService.findConversationByPrefix(parsed.tok8, userId);
  if (!row) {
    console.log(`[INTERCEPT] tap ${callbackId} ignorado: sesión inexistente o de otro usuario`);
    return [{ type: 'text', text: '⚠️ Ese botón ya no está vigente. Escribí *formulario* para empezar uno nuevo.' }];
  }
  if (row.used_at && row.status === 'submitted') {
    console.log(`[INTERCEPT] tap ${callbackId}: formulario ya confirmado`);
    return [{ type: 'text', text: '✅ Eso ya quedó registrado. No lo dupliqué.' }];
  }
  if (row.status === 'cancelled') {
    return [{ type: 'text', text: '👍 Ese formulario ya lo habías descartado. Escribí *formulario* para empezar otro.' }];
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    if (ptr?.token === row.token) formConversationStore.clear(ctx.phone);
    return expiredItems(row.action as FormAction);
  }

  const s = await hydrateSession(row);
  if (!s) return null;
  refreshAutoDate(s);

  if (parsed.verb === 'resume') return resumeConversationForm(ctx, s.action, s.token);
  if (parsed.verb === 'restart') {
    await formSessionService.setConversationStatus(s.token, s.userId, 'cancelled');
    if (ptr?.token === s.token) formConversationStore.clear(ctx.phone);
    return startConversationForm(ctx, { action: s.action, prefill: {} }, { forceNew: true });
  }

  // Cualquier otro tap sobre un formulario que no es el activo lo activa.
  if (ptr?.token !== s.token) {
    const parked = await parkActive(ctx, s.token);
    await activate(ctx, s);
    if (parked.length) console.log(`[FORM] tap activó ${s.action}; el anterior quedó estacionado`);
  }

  if (parsed.verb === 'cancel') return cancel(ctx, s);
  if (parsed.verb === 'ok') {
    if (s.awaiting !== AWAIT_CONFIRM) {
      console.log(`[INTERCEPT] tap ok fuera del resumen token=${s.token.slice(0, 8)}`);
      return reprompt(s, ['Todavía faltan datos:']);
    }
    return confirm(ctx, s, deps);
  }
  if (parsed.verb === 'edit') {
    s.awaiting = AWAIT_EDIT;
    s.status = 'confirming';
    await persist(s);
    return reprompt(s);
  }
  const edit = /^e(\d{1,2})$/.exec(parsed.verb);
  if (edit) {
    const f = s.def.fields[Number(edit[1])];
    return f ? startEditing(s, f) : reprompt(s);
  }
  const awaitedField = fieldByKey(s.def, s.awaiting);
  if (parsed.verb === 'skip') {
    if (awaitedField && !awaitedField.required) return skipField(s, awaitedField);
    return reprompt(s);
  }
  if (parsed.verb === 'other') {
    return [{ type: 'text', text: `✍️ Escribí ${awaitedField ? awaitedField.label.toLowerCase() : 'el dato'} tal como lo llamás.` }];
  }
  const opt = /^o(\d{1,2})$/.exec(parsed.verb);
  if (opt) {
    // Un tap solo responde la pregunta que lo mostró (botón viejo = ignorado).
    const choices = s.draft.choices;
    if (!awaitedField || !choices || choices.field !== awaitedField.key) {
      console.log(`[INTERCEPT] tap ${callbackId} ignorado: la pregunta abierta es ${s.awaiting ?? 'ninguna'}`);
      return reprompt(s);
    }
    const value = choices.ids[Number(opt[1])];
    if (value === undefined) return reprompt(s);
    const r = applyCandidates(s, { [awaitedField.key]: value });
    if (r.rejected[0]) return ask(s, awaitedField, { reason: `🤔 ${r.rejected[0].error}` });
    return advance(s);
  }
  console.log(`[INTERCEPT] tap ${callbackId} sin ruta`);
  return reprompt(s);
}
