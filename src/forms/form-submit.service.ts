// src/forms/form-submit.service.ts
// Submit de un formulario estructurado: valida contra la FormDefinition,
// resuelve las referencias (lote / campo / corral) con scoping por usuario,
// serializa con el lock del usuario y entra por DomainRouter.routeCommand
// (mismo handler que el chat — cero IA).
//
// Es el ÚNICO camino de persistencia de los tres renderers: form web
// (Telegram Mini App), WhatsApp Flow (nfm_reply, hoy apagado) y el colector
// conversacional de WhatsApp. Ninguno escribe por su cuenta.
//
// Idempotencia (Sep 2026): el token se RECLAMA de forma atómica dentro de la
// misma transacción que el write. Antes se validaba fuera del lock y se
// marcaba usado al final: dos POST / dos nfm_reply concurrentes pasaban la
// validación y escribían dos veces.
import { pool, withTransaction } from '../config/db.js';
import { formSessionService, type FormSessionRow } from '../services/form-session.service.js';
import { FORM_DEFINITIONS, validateFormPayload, type FormAction, type FormDefinition } from './form-definitions.js';
import { buildFormCommand, FORM_PERSISTS_TO, type ResolvedRefs } from './form-commands.js';
import { parseLocationId, computeFormOptions, NO_LOCATION_ID } from './form-options.js';
import { unflattenFlowPayload } from './whatsapp-flow-generator.js';
import {
  domainRouter, userRepository, pendingActStore,
  hydratePendingStores, applySideEffects,
} from '../services/message-pipeline.js';
import { withUserLock } from '../middleware/user-lock.js';
import { sendTelegramMessage, sendTelegramButtons, sendTelegramList } from '../services/telegram.js';
import { sendMessage as sendWhatsAppText, sendInteractiveButtons, sendInteractiveList } from '../services/whatsapp.js';
import { CategoryRepository } from '../domain/financial/category.repository.js';
import { CategoryService } from '../domain/financial/category.service.js';
import { getActiveCrop } from '../services/expenses.js';
import { accessibleFieldsSql } from '../domain/shared/accessible-fields.js';
import { getTodayISO } from '../utils/date.js';
import { isGrainSaleCategory } from '../utils/crops.js';
import type { HandlerResponse, InteractiveMessage } from '../types/index.js';

type SubmitResult =
  | { ok: true; message: string; response?: HandlerResponse }
  | { ok: false; status: number; error: string; field?: string };

export interface SubmitFormOptions {
  /**
   * El payload viene de un WhatsApp Flow (nfm_reply): los grupos llegan
   * aplanados (`loads_1_driver_name`…) y hay que re-armarlos antes de validar.
   */
  flowResponse?: boolean;
  /**
   * `chat` (default): la confirmación se empuja al chat del usuario (form web
   * y Flow no tienen otro canal de vuelta). `return`: el llamador la rinde
   * como respuesta del turno (colector conversacional).
   */
  deliver?: 'chat' | 'return';
  /** Si viene, el token tiene que ser de ESTE usuario (anti-IDOR). */
  userId?: number;
  /**
   * El llamador YA corre dentro del lock del usuario (nfm_reply del webhook de
   * WhatsApp, confirmación del colector conversacional). withUserLock no es
   * reentrante: pedirlo de nuevo con la misma clave se trabaría para siempre.
   */
  alreadyLocked?: boolean;
}

/**
 * Clave del lock por usuario IGUAL a la de los controllers (wa:/tg:/tb:).
 * Antes el submit usaba `session.phone` a secas: un POST del form web no se
 * serializaba con los mensajes de chat del mismo usuario.
 */
export function lockKeyForSession(session: Pick<FormSessionRow, 'channel' | 'channel_id' | 'phone'>): string {
  if (session.channel === 'whatsapp') return `wa:${session.phone}`;
  if (session.channel === 'telegram') return `tg:${session.channel_id}`;
  return `tb:${session.phone}`;
}

export const DUPLICATE_SUBMIT_MESSAGE = '✅ Eso ya quedó registrado. No lo dupliqué.';
const EXPIRED_MESSAGE = 'Este formulario venció. Pedime otro en el chat con «formulario» y elegí cuál.';

// Ownership con la fuente ÚNICA de acceso (accessibleFieldsSql): el dueño Y los
// miembros de un campo compartido. Antes era `f.user_id = $2` (solo dueño)
// mientras computeFormOptions ofrecía también los campos compartidos: un
// colaborador elegía su lote y el submit decía "ya no existe".
async function loadUserPlot(
  userId: number,
  plotId: number,
): Promise<{ id: number; name: string; field_name: string } | null> {
  if (!Number.isInteger(plotId) || plotId <= 0) return null;
  const { rows } = await pool.query(
    `SELECT p.id, p.name, f.name AS field_name
       FROM plots p JOIN fields f ON f.id = p.field_id
      WHERE p.id = $1 AND p.deleted_at IS NULL AND f.deleted_at IS NULL
        AND f.id IN (${accessibleFieldsSql(2)})`,
    [plotId, userId],
  );
  return rows[0] ?? null;
}

async function loadUserField(userId: number, fieldId: number): Promise<{ id: number; name: string } | null> {
  if (!Number.isInteger(fieldId) || fieldId <= 0) return null;
  const { rows } = await pool.query(
    `SELECT f.id, f.name FROM fields f
      WHERE f.id = $1 AND f.deleted_at IS NULL AND f.id IN (${accessibleFieldsSql(2)})`,
    [fieldId, userId],
  );
  return rows[0] ?? null;
}

async function loadUserCorral(
  userId: number,
  corralId: number,
): Promise<{ id: number; name: string; feedlot_name: string | null; field_name: string } | null> {
  if (!Number.isInteger(corralId) || corralId <= 0) return null;
  const { rows } = await pool.query(
    `SELECT c.id, c.name, fl.name AS feedlot_name, f.name AS field_name
       FROM corrals c JOIN feedlots fl ON fl.id = c.feedlot_id JOIN fields f ON f.id = fl.field_id
      WHERE c.id = $1 AND c.deleted_at IS NULL AND fl.deleted_at IS NULL AND f.deleted_at IS NULL
        AND f.id IN (${accessibleFieldsSql(2)})`,
    [corralId, userId],
  );
  return rows[0] ?? null;
}

/**
 * Confirmación al chat tras un submit del form web / Flow, CON los botones del
 * paso siguiente si el handler los ofreció (cargar el grano al stock, descontar
 * el producto del depósito, costo de cosecha). Antes solo iba el texto: el
 * pending de esos botones se aplicaba igual y quedaba una pregunta colgada que
 * el usuario nunca vio.
 */
async function sendToChat(session: FormSessionRow, text: string, interactive?: InteractiveMessage): Promise<void> {
  try {
    if (session.channel === 'telegram') {
      if (text) await sendTelegramMessage(session.channel_id, text);
      if (interactive?.type === 'buttons') await sendTelegramButtons(session.channel_id, interactive.body, interactive.buttons);
      else if (interactive?.type === 'list') await sendTelegramList(session.channel_id, interactive.body, interactive.sections);
    } else if (session.channel === 'whatsapp') {
      if (text) await sendWhatsAppText(session.channel_id, text);
      if (interactive?.type === 'buttons') await sendInteractiveButtons(session.channel_id, interactive.body, interactive.buttons);
      else if (interactive?.type === 'list') await sendInteractiveList(session.channel_id, interactive.body, interactive.buttonText, interactive.sections);
    }
    // testbot: sin push — el resultado viaja en la respuesta HTTP del form
    if (interactive) console.log(`[FORM] interactive de éxito reenviado al chat (${session.channel})`);
  } catch (err) {
    console.error('[FORM] fallo el envío de confirmación al chat:', err);
  }
}

const STALE_REF = 'Ese lote o ubicación ya no existe. Cerrá y pedí el formulario de nuevo.';

/**
 * Selects con opciones DINÁMICAS sin "otro": el valor tiene que estar en la
 * lista de ESE usuario (categoría de hacienda, raza…). Antes solo se validaban
 * las opciones fijas; un payload manipulado pasaba cualquier string al handler.
 * Lote/ubicación se validan aparte (ownership contra la DB).
 */
function allowListedFields(def: FormDefinition) {
  return def.fields.filter(f =>
    f.type === 'select' && f.optionsSource && !f.allowOther
    && f.key !== 'plot_id' && f.key !== 'location');
}

export type PreparedSubmission =
  | { ok: true; data: Record<string, unknown>; refs: ResolvedRefs }
  | { ok: false; status: number; error: string; field?: string };

/**
 * Todo lo que se valida ANTES de escribir, sin escribir nada: payload contra
 * la FormDefinition, ownership de lote/campo/corral, allow-list de selects
 * dinámicos y cultivo activo de la cosecha. La usa el submit (dentro del
 * lock) y el colector conversacional ANTES de mostrar el resumen — así un
 * resumen nunca promete algo que el submit después rechaza.
 */
export async function prepareSubmission(
  userId: number,
  action: FormAction,
  payload: Record<string, unknown>,
): Promise<PreparedSubmission> {
  const def = FORM_DEFINITIONS[action];
  const refs: ResolvedRefs = {};

  // Lote directo (siembra, cosecha, labores): obligatorio y accesible.
  if (def.fields.some(f => f.key === 'plot_id')) {
    const plot = await loadUserPlot(userId, Number(payload.plot_id));
    if (!plot) {
      console.log('[FORM] rejected: lote ajeno o inexistente');
      return { ok: false, status: 422, field: 'plot_id', error: 'El lote elegido ya no existe. Cerrá y pedí el formulario de nuevo.' };
    }
    refs.plot = { id: plot.id, name: plot.name, fieldName: plot.field_name };
  }

  const validated = validateFormPayload(def, payload, getTodayISO());
  if (!validated.ok) {
    console.log(`[FORM] rejected: validación (${validated.errors.length} errores)`);
    return { ok: false, status: 422, error: validated.errors.join('\n') };
  }
  const data = validated.data;
  if (typeof payload.category_other === 'string' && payload.category_other.trim()) {
    const catField = def.fields.find(f => f.key === 'category');
    const kind = catField?.optionsSource === 'expense_categories' ? 'expense'
      : catField?.optionsSource === 'income_categories' ? 'income' : null;
    // El colector ya preguntó "crear nueva / usar la parecida". El form web y
    // el Flow no pueden preguntar: elegir "Otro…" y escribir ES la decisión de
    // crearla — salvo que exista una casi igual (plural, error de tipeo), que
    // se usa en vez de duplicar.
    const similar = kind && payload.category_other_confirmed !== true
      ? await new CategoryService(new CategoryRepository()).findSimilar(userId, kind, payload.category_other.trim()).catch(() => null)
      : null;
    if (similar) {
      console.log(`[FORM] categoría "${payload.category_other.trim()}" → se usa la parecida "${similar.name}"`);
      data.category = similar.name;
    } else {
      refs.newCategory = true;
    }
  }

  // Gasto / ingreso SIN lote es una elección, no un dato faltante. Antes el
  // formulario ofrecía "Omitir" y "Todo el campo" y el handler igual contestaba
  // "¿En qué lote lo registramos?" (QA formularios, oct 2026).
  const locField = def.fields.find(f => f.key === 'location');
  if (locField?.optionsSource === 'locations') {
    if (data.location === NO_LOCATION_ID) {
      refs.noLocation = true;
      delete data.location;
    } else if (data.location === undefined && action === 'log_income'
        && typeof data.buyer === 'string' && data.buyer
        && isGrainSaleCategory(data.category)) {
      // Venta de grano con comprador: el handler deduce el lote de la campaña
      // del cultivo (o la deja a nivel campo). No es una ubicación faltante.
    } else if (data.location === undefined) {
      const o = await computeFormOptions(action, userId);
      if (o.plots.length > 1) {
        // Con un solo lote el handler lo asigna solo (como siempre).
        if (o.fields.length === 1) {
          refs.field = o.fields[0];
          refs.fieldLevel = true;
        } else {
          console.log('[FORM] rejected: sin ubicación con varios campos');
          return { ok: false, status: 422, field: 'location', error: 'Elegí un lote, un campo o «Ninguno (general)».' };
        }
      }
    }
  }

  // Ubicación mixta (gasto, ingreso, hacienda): p:/f:/c: con scoping por usuario.
  if (locField && data.location !== undefined) {
    const ref = parseLocationId(data.location);
    if (!ref) { console.log('[FORM] rejected: location inválida'); return { ok: false, status: 422, field: 'location', error: STALE_REF }; }
    if (ref.kind === 'plot') {
      const plot = await loadUserPlot(userId, ref.id);
      if (!plot) { console.log('[FORM] rejected: lote ajeno o inexistente'); return { ok: false, status: 422, field: 'location', error: STALE_REF }; }
      refs.plot = { id: plot.id, name: plot.name, fieldName: plot.field_name };
    } else if (ref.kind === 'field') {
      const field = await loadUserField(userId, ref.id);
      if (!field) { console.log('[FORM] rejected: campo ajeno o inexistente'); return { ok: false, status: 422, field: 'location', error: STALE_REF }; }
      refs.field = field;
      refs.fieldLevel = true;
    } else {
      const corral = await loadUserCorral(userId, ref.id);
      if (!corral) { console.log('[FORM] rejected: corral ajeno o inexistente'); return { ok: false, status: 422, field: 'location', error: STALE_REF }; }
      refs.corral = { id: corral.id, name: corral.name, feedlotName: corral.feedlot_name, fieldName: corral.field_name };
    }
  }

  const listed = allowListedFields(def).filter(f => data[f.key] !== undefined);
  if (listed.length > 0) {
    const opts = await computeFormOptions(action, userId);
    for (const f of listed) {
      const allowed = opts.lists[f.optionsSource!] ?? [];
      if (!allowed.some(o => o.id === data[f.key])) {
        console.log(`[FORM] rejected: opción fuera de la lista field=${f.key}`);
        return { ok: false, status: 422, field: f.key, error: `${f.label}: opción inválida.` };
      }
    }
  }

  // Siembra sobre un lote con OTRO cultivo activo: no se rechaza acá (el
  // colector lo avisa en el resumen); el commit exige la confirmación.
  if (action === 'sow_crop' && refs.plot) {
    const active = await getActiveCrop(refs.plot.id) as { crop: string } | null;
    const crop = typeof data.crop === 'string' ? data.crop : '';
    refs.activeOther = active && crop && active.crop.toLowerCase() !== crop.toLowerCase() ? active.crop : null;
    const confirmed = typeof payload.replace_active_crop === 'string' ? payload.replace_active_crop : '';
    refs.replaceConfirmed = !!refs.activeOther && confirmed.toLowerCase() === refs.activeOther.toLowerCase();
  }

  if (action === 'harvest_crop' && refs.plot) {
    const active = await getActiveCrop(refs.plot.id);
    if (!active) {
      console.log('[FORM] rejected: lote sin cultivo activo');
      return { ok: false, status: 422, field: 'plot_id', error: 'Ese lote no tiene cultivo activo para cosechar.' };
    }
    refs.activeCrop = (active as { crop: string }).crop;
  }

  return { ok: true, data, refs };
}

/**
 * ¿El handler GUARDÓ el registro? Se mira en la MISMA transacción qué tablas
 * escribió (pg_stat_xact_user_tables) contra FORM_PERSISTS_TO. Una pregunta de
 * vuelta (picker de categoría, "¿en qué lote?") no escribe esas tablas: no es
 * éxito aunque traiga texto. null = no se pudo medir (se decide por la forma
 * de la respuesta, como antes).
 */
async function recordWasWritten(action: FormAction): Promise<boolean | null> {
  try {
    const res = await pool.query(
      `SELECT relname FROM pg_stat_xact_user_tables
        WHERE relname = ANY($1::text[]) AND (n_tup_ins + n_tup_upd) > 0`,
      [FORM_PERSISTS_TO[action]],
    );
    if (!res || !Array.isArray(res.rows)) return null;
    return res.rows.length > 0;
  } catch (err) {
    console.warn('[FORM] no pude verificar la escritura del registro:', (err as Error).message);
    return null;
  }
}

/**
 * Qué dato del formulario pide un handler que contestó con una pregunta en vez
 * de guardar (para que el colector conversacional re-pregunte ESE campo).
 */
function fieldAskedBy(def: FormDefinition, r: HandlerResponse): string | undefined {
  const has = (k: string) => def.fields.some(f => f.key === k);
  const inter = r.interactive;
  const ids = inter
    ? (inter.type === 'buttons' ? inter.buttons.map(b => b.id) : inter.sections.flatMap(s => s.rows.map(x => x.id)))
    : [];
  if (ids.some(id => id.startsWith('cat_')) && has('category')) return 'category';
  const missing = (r.sideEffects?.setPendingActivity as { missing?: string[] } | undefined)?.missing ?? [];
  const wantsPlace = missing.some(m => m === 'plot' || m === 'field')
    || ids.some(id => /^(flow_plot_|flow_field_|lv_loc_|bap2_)/.test(id));
  if (wantsPlace) return has('location') ? 'location' : has('plot_id') ? 'plot_id' : undefined;
  const direct = missing.find(m => has(m));
  return direct;
}

/** Error interno para abortar la transacción del commit (rollback del claim). */
class CommitAborted extends Error {
  constructor(readonly result: SubmitResult) { super('commit aborted'); }
}

async function explainDeadToken(token: string): Promise<SubmitResult> {
  const row = await formSessionService.find(token).catch(() => null);
  if (row?.used_at && (row.status === 'submitted' || row.status == null)) {
    console.log('[FORM] rejected: token ya usado (submit duplicado)');
    return { ok: false, status: 409, error: DUPLICATE_SUBMIT_MESSAGE };
  }
  console.log('[FORM] rejected: token inválido/vencido');
  return { ok: false, status: 404, error: EXPIRED_MESSAGE };
}

export async function submitForm(
  token: string,
  rawPayload: Record<string, unknown>,
  opts: SubmitFormOptions = {},
): Promise<SubmitResult> {
  const session = await formSessionService.validate(token);
  if (!session) return explainDeadToken(token);
  if (opts.userId !== undefined && Number(session.user_id) !== Number(opts.userId)) {
    // Nunca confirmar que el token existe para otro usuario.
    console.warn(`[FORM] rejected: token de otro usuario (user=${opts.userId})`);
    return { ok: false, status: 404, error: EXPIRED_MESSAGE };
  }

  const action = session.action as FormAction;
  const def = FORM_DEFINITIONS[action];
  if (!def) {
    console.log(`[FORM] rejected: action desconocida ${String(session.action)}`);
    return { ok: false, status: 404, error: 'Este formulario ya no existe. Pedime otro en el chat.' };
  }

  let payload = rawPayload;
  if (opts.flowResponse) {
    payload = unflattenFlowPayload(def, rawPayload);
    const groups = def.fields.filter(f => f.type === 'group').map(f => `${f.key}=${(payload[f.key] as unknown[] | undefined)?.length ?? 0}`);
    console.log(`[FORM] flow payload re-armado action=${action} campos=[${Object.keys(payload).join(', ')}]${groups.length ? ` grupos=[${groups.join(', ')}]` : ''}`);
  }

  const { rows: userRows } = await pool.query(
    'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
    [session.user_id],
  );
  const user = userRows[0];
  if (!user) return { ok: false, status: 404, error: 'Usuario no encontrado.' };

  const commit = async (): Promise<SubmitResult> => {
    await hydratePendingStores(session.phone);

    // Caso borde del spec: había un pending al ofrecer el form y ya no está →
    // se resolvió por chat. No duplicar; cerrar el token.
    const pending = pendingActStore.get(session.phone);
    if (session.had_pending && !pending) {
      console.log('[FORM] rejected: pending ya resuelto por chat');
      await formSessionService.claim(token);
      return { ok: false, status: 409, error: '⚠️ Esto ya se registró por el chat. No lo dupliqué.' };
    }

    // Validación completa DENTRO del lock: el estado (lotes, cultivo activo)
    // no cambia entre validar y escribir.
    const prepared = await prepareSubmission(session.user_id, action, payload);
    if (!prepared.ok) return prepared;
    if (prepared.refs.activeOther && !prepared.refs.replaceConfirmed) {
      // Form web / Flow no tienen cómo confirmar un reemplazo de campaña.
      console.log('[FORM] rejected: siembra sobre lote con otro cultivo activo sin confirmar');
      return {
        ok: false, status: 422, field: 'plot_id',
        error: `El lote ${prepared.refs.plot?.name ?? ''} ya tiene ${prepared.refs.activeOther} activo. Elegí otro lote, o cargá la siembra por el chat para reemplazar esa campaña.`,
      };
    }
    const cmd = buildFormCommand(action, prepared.data, prepared.refs);

    // El formulario YA es la confirmación: no volver a preguntar "¿confirmás?"
    // (el submit trataría los botones como éxito y quemaría el token sin guardar).
    const settings = await userRepository.getSettings(session.user_id as never);

    let response: HandlerResponse;
    try {
      response = await withTransaction(async () => {
        const claimed = await formSessionService.claim(token);
        if (!claimed) throw new CommitAborted(await explainDeadToken(token));

        const r = await domainRouter.routeCommand(
          cmd as never,
          session.user_id as never,
          user,
          { ...settings, confirm_before_save: false } as typeof settings,
        );
        const fx = r?.sideEffects as Record<string, unknown> | undefined;
        // Una tarjeta "¿Confirmo?" (setPending) también es una pregunta abierta:
        // con confirm_before_save:false no debería aparecer, pero si aparece
        // el registro NO está guardado.
        const blocking = !!(fx?.setPendingActivity || fx?.startFlow || fx?.setPending || fx?.setFieldDuplicate);
        const firstMsg = r?.messages?.[0] ?? '';
        const written = r ? await recordWasWritten(action) : false;
        // El handler dice "eso ya estaba registrado, nada nuevo que sumar"
        // (siembra / cosecha repetida): no escribe y NO es un error — el
        // formulario se cierra con ese mensaje.
        const alreadyRecorded = r?.alreadyRecorded === true;
        const failed = !r || blocking || firstMsg.startsWith('❌')
          || (written === false && !alreadyRecorded)
          || (written === null && !firstMsg);
        if (failed) {
          const question = r?.interactive?.body ?? '';
          const error = (firstMsg.startsWith('❌') ? firstMsg : '') || question || firstMsg
            || 'No se pudo registrar. Probá de nuevo o cargalo por el chat.';
          const field = r ? fieldAskedBy(def, r) : undefined;
          console.log('[FORM] rejected: handler no guardó', { blocking, written, field, msg: error.slice(0, 80) });
          // Rollback: el token vuelve a quedar libre para corregir y reintentar.
          throw new CommitAborted({ ok: false, status: 422, error, ...(field ? { field } : {}) });
        }
        return r;
      }) as HandlerResponse;
    } catch (err) {
      if (err instanceof CommitAborted) return err.result;
      throw err;
    }

    // Éxito: side effects legítimos (ej. botones de cierre de campaña tras
    // cosecha) se aplican por la vía canónica (invariante 9).
    if (response.sideEffects) {
      applySideEffects(response.sideEffects, session.phone);
    }

    const fullText = (response.messages ?? []).join('\n\n');
    if ((opts.deliver ?? 'chat') === 'chat') {
      await sendToChat(session, fullText, response.interactive);
    }
    // Un handler puede confirmar SOLO con botones (alta de hacienda: mensaje
    // vacío + interactive). La pantalla web recibía message:'' y se quedaba sin
    // mostrar nada aunque el registro estaba guardado.
    const resultText = fullText || response.interactive?.body || '✅ Registrado.';

    // Si había un pending del mismo action y ya no tiene cola, limpiarlo
    const pendingCmd = (pending as { command?: string } | undefined)?.command;
    const sameAction = pendingCmd === action || pendingCmd === (cmd.command as string);
    if (pending && sameAction && !(pending as { nextInQueue?: unknown[] }).nextInQueue?.length) {
      pendingActStore.clear(session.phone);
      console.log('[FORM] pending consumido por submit');
    }

    console.log(`[FORM] submitted action=${action} cmd=${String(cmd.command)} user=${session.user_id} msg="${fullText.slice(0, 80).replace(/\n/g, ' ')}"`);
    return { ok: true, message: resultText, response };
  };

  return opts.alreadyLocked ? commit() : withUserLock(lockKeyForSession(session), commit);
}
