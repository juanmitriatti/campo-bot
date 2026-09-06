// src/forms/form-submit.service.ts
// Submit de un formulario estructurado: valida contra la FormDefinition,
// resuelve las referencias (lote / campo / corral) con scoping por usuario,
// serializa con el lock del usuario y entra por DomainRouter.routeCommand
// (mismo handler que el chat — cero IA). Token de un solo uso = idempotencia.
import { pool } from '../config/db.js';
import { formSessionService, type FormSessionRow } from '../services/form-session.service.js';
import { FORM_DEFINITIONS, validateFormPayload, type FormAction } from './form-definitions.js';
import { buildFormCommand, type ResolvedRefs } from './form-commands.js';
import { parseLocationId } from './form-options.js';
import { unflattenFlowPayload } from './whatsapp-flow-generator.js';
import {
  domainRouter, userRepository, pendingActStore,
  hydratePendingStores, applySideEffects,
} from '../services/message-pipeline.js';
import { withUserLock } from '../middleware/user-lock.js';
import { sendTelegramMessage } from '../services/telegram.js';
import { sendMessage as sendWhatsAppText } from '../services/whatsapp.js';
import { getActiveCrop } from '../services/expenses.js';
import { getTodayISO } from '../utils/date.js';

type SubmitResult =
  | { ok: true; message: string }
  | { ok: false; status: number; error: string };

export interface SubmitFormOptions {
  /**
   * El payload viene de un WhatsApp Flow (nfm_reply): los grupos llegan
   * aplanados (`loads_1_driver_name`…) y hay que re-armarlos antes de validar.
   */
  flowResponse?: boolean;
}

async function loadUserPlot(
  userId: number,
  plotId: number,
): Promise<{ id: number; name: string; field_name: string } | null> {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, f.name AS field_name
       FROM plots p JOIN fields f ON f.id = p.field_id
      WHERE p.id = $1 AND f.user_id = $2 AND p.deleted_at IS NULL AND f.deleted_at IS NULL`,
    [plotId, userId],
  );
  return rows[0] ?? null;
}

async function loadUserField(userId: number, fieldId: number): Promise<{ id: number; name: string } | null> {
  const { rows } = await pool.query(
    `SELECT id, name FROM fields WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [fieldId, userId],
  );
  return rows[0] ?? null;
}

async function loadUserCorral(
  userId: number,
  corralId: number,
): Promise<{ id: number; name: string; feedlot_name: string | null } | null> {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, fl.name AS feedlot_name
       FROM corrals c JOIN feedlots fl ON fl.id = c.feedlot_id JOIN fields f ON f.id = fl.field_id
      WHERE c.id = $1 AND f.user_id = $2 AND c.deleted_at IS NULL AND fl.deleted_at IS NULL AND f.deleted_at IS NULL`,
    [corralId, userId],
  );
  return rows[0] ?? null;
}

async function sendToChat(session: FormSessionRow, text: string): Promise<void> {
  try {
    if (session.channel === 'telegram') await sendTelegramMessage(session.channel_id, text);
    else if (session.channel === 'whatsapp') await sendWhatsAppText(session.channel_id, text);
    // testbot: sin push — el resultado viaja en la respuesta HTTP del form
  } catch (err) {
    console.error('[FORM] fallo el envío de confirmación al chat:', err);
  }
}

const STALE_REF = 'Ese lote o ubicación ya no existe. Cerrá y pedí el formulario de nuevo.';

export async function submitForm(
  token: string,
  rawPayload: Record<string, unknown>,
  opts: SubmitFormOptions = {},
): Promise<SubmitResult> {
  const session = await formSessionService.validate(token);
  if (!session) {
    console.log('[FORM] rejected: token inválido/vencido');
    return {
      ok: false,
      status: 404,
      error: 'Este formulario venció. Pedime otro en el chat con «formulario» y elegí cuál.',
    };
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

  const refs: ResolvedRefs = {};

  // Lote directo (siembra, cosecha, labores): obligatorio y del usuario.
  if (def.fields.some(f => f.key === 'plot_id')) {
    const plot = await loadUserPlot(session.user_id, Number(payload.plot_id));
    if (!plot) {
      console.log('[FORM] rejected: lote ajeno o inexistente');
      return { ok: false, status: 422, error: 'El lote elegido ya no existe. Cerrá y pedí el formulario de nuevo.' };
    }
    refs.plot = { id: plot.id, name: plot.name, fieldName: plot.field_name };
  }

  const validated = validateFormPayload(def, payload, getTodayISO());
  if (!validated.ok) {
    console.log(`[FORM] rejected: validación (${validated.errors.length} errores)`);
    return { ok: false, status: 422, error: validated.errors.join('\n') };
  }
  const data = validated.data;

  // Ubicación mixta (gasto, ingreso, hacienda): p:/f:/c: con scoping por usuario.
  if (def.fields.some(f => f.key === 'location') && data.location !== undefined) {
    const ref = parseLocationId(data.location);
    if (!ref) { console.log('[FORM] rejected: location inválida'); return { ok: false, status: 422, error: STALE_REF }; }
    if (ref.kind === 'plot') {
      const plot = await loadUserPlot(session.user_id, ref.id);
      if (!plot) { console.log('[FORM] rejected: lote ajeno o inexistente'); return { ok: false, status: 422, error: STALE_REF }; }
      refs.plot = { id: plot.id, name: plot.name, fieldName: plot.field_name };
    } else if (ref.kind === 'field') {
      const field = await loadUserField(session.user_id, ref.id);
      if (!field) { console.log('[FORM] rejected: campo ajeno o inexistente'); return { ok: false, status: 422, error: STALE_REF }; }
      refs.field = field;
    } else {
      const corral = await loadUserCorral(session.user_id, ref.id);
      if (!corral) { console.log('[FORM] rejected: corral ajeno o inexistente'); return { ok: false, status: 422, error: STALE_REF }; }
      refs.corral = { id: corral.id, name: corral.name, feedlotName: corral.feedlot_name };
    }
  }

  return withUserLock(session.phone, async (): Promise<SubmitResult> => {
    await hydratePendingStores(session.phone);

    // Caso borde del spec: había un pending al ofrecer el form y ya no está →
    // se resolvió por chat. No duplicar; cerrar el token.
    const pending = pendingActStore.get(session.phone);
    if (session.had_pending && !pending) {
      console.log('[FORM] rejected: pending ya resuelto por chat');
      await formSessionService.markUsed(token);
      return { ok: false, status: 409, error: '⚠️ Esto ya se registró por el chat. No lo dupliqué.' };
    }

    if (action === 'harvest_crop' && refs.plot) {
      const active = await getActiveCrop(refs.plot.id);
      if (!active) {
        console.log('[FORM] rejected: lote sin cultivo activo');
        return { ok: false, status: 422, error: 'Ese lote no tiene cultivo activo para cosechar.' };
      }
      refs.activeCrop = (active as { crop: string }).crop;
    }

    const cmd = buildFormCommand(action, data, refs);

    // El formulario YA es la confirmación: no volver a preguntar "¿confirmás?"
    // (el submit trataría los botones como éxito y quemaría el token sin guardar).
    const settings = await userRepository.getSettings(session.user_id as never);
    const response = await domainRouter.routeCommand(
      cmd as never,
      session.user_id as never,
      user,
      { ...settings, confirm_before_save: false } as typeof settings,
    );

    const blocking = !!(response?.sideEffects?.setPendingActivity || response?.sideEffects?.startFlow);
    const firstMsg = response?.messages?.[0] ?? '';

    if (!response || blocking || !firstMsg || firstMsg.startsWith('❌')) {
      console.log('[FORM] rejected: handler no confirmó', {
        blocking,
        firstMsg: firstMsg.slice(0, 60),
      });
      return {
        ok: false,
        status: 422,
        error: firstMsg || 'No se pudo registrar. Probá de nuevo o cargalo por el chat.',
      };
    }

    // Éxito: side effects legítimos (ej. botones de cierre de campaña tras
    // cosecha) se aplican por la vía canónica (invariante 9).
    if (response.sideEffects) {
      applySideEffects(response.sideEffects, session.phone);
    }

    // interactive de éxito (ej. botones de cierre de campaña) no se reenvía en v1
    if (response.interactive) {
      console.log('[FORM] interactive de éxito no reenviado (v1)');
    }

    const fullText = (response.messages ?? []).join('\n\n');
    await sendToChat(session, fullText);
    await formSessionService.markUsed(token);

    // Si había un pending del mismo action y ya no tiene cola, limpiarlo
    const pendingCmd = (pending as { command?: string } | undefined)?.command;
    const sameAction = pendingCmd === action || pendingCmd === (cmd.command as string);
    if (pending && sameAction && !(pending as { nextInQueue?: unknown[] }).nextInQueue?.length) {
      pendingActStore.clear(session.phone);
      console.log('[FORM] pending consumido por submit');
    }

    console.log(`[FORM] submitted action=${action} cmd=${String(cmd.command)} user=${session.user_id}`);
    return { ok: true, message: fullText };
  });
}
