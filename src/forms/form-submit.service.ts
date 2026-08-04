// src/forms/form-submit.service.ts
// Submit de un formulario estructurado: valida contra la FormDefinition,
// serializa con el lock del usuario y entra por DomainRouter.routeCommand
// (mismo handler que el chat — cero IA). Token de un solo uso = idempotencia.
import { pool } from '../config/db.js';
import { formSessionService, type FormSessionRow } from '../services/form-session.service.js';
import { FORM_DEFINITIONS, validateFormPayload } from './form-definitions.js';
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

async function sendToChat(session: FormSessionRow, text: string): Promise<void> {
  try {
    if (session.channel === 'telegram') await sendTelegramMessage(session.channel_id, text);
    else if (session.channel === 'whatsapp') await sendWhatsAppText(session.channel_id, text);
    // testbot: sin push — el resultado viaja en la respuesta HTTP del form
  } catch (err) {
    console.error('[FORM] fallo el envío de confirmación al chat:', err);
  }
}

export async function submitForm(
  token: string,
  payload: Record<string, unknown>,
): Promise<SubmitResult> {
  const session = await formSessionService.validate(token);
  if (!session) {
    console.log('[FORM] rejected: token inválido/vencido');
    return {
      ok: false,
      status: 404,
      error: 'Este formulario venció. Pedime otro en el chat con «formulario siembra» o «formulario cosecha».',
    };
  }

  const def = FORM_DEFINITIONS[session.action as 'sow_crop' | 'harvest_crop'];

  const { rows: userRows } = await pool.query(
    'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
    [session.user_id],
  );
  const user = userRows[0];
  if (!user) return { ok: false, status: 404, error: 'Usuario no encontrado.' };

  const plotId = Number(payload.plot_id);
  const plot = await loadUserPlot(session.user_id, plotId);
  if (!plot) {
    console.log('[FORM] rejected: lote ajeno o inexistente');
    return {
      ok: false,
      status: 422,
      error: 'El lote elegido ya no existe. Cerrá y pedí el formulario de nuevo.',
    };
  }

  // Validate payload AFTER we have the plot (needed for cross-field rules
  // but validation itself only needs def + payload + today).
  const validated = validateFormPayload(def, payload, getTodayISO());
  if (!validated.ok) {
    console.log(`[FORM] rejected: validación (${validated.errors.length} errores)`);
    return { ok: false, status: 422, error: validated.errors.join('\n') };
  }
  const data = validated.data;

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

    let crop: string | null = (data.crop as string) ?? null;
    if (session.action === 'harvest_crop') {
      const active = await getActiveCrop(plot.id);
      if (!active) {
        console.log('[FORM] rejected: lote sin cultivo activo');
        return { ok: false, status: 422, error: 'Ese lote no tiene cultivo activo para cosechar.' };
      }
      crop = (active as { crop: string }).crop;
    }

    const originalText =
      `[formulario] ${session.action === 'sow_crop' ? 'siembra' : 'cosecha'} ${crop ?? ''} en ${plot.name}`.trim();

    const base = {
      crop,
      plotName: plot.name,
      fieldName: plot.field_name,
      eventDate: data.event_date as string,
      originalText,
    };

    const cmd =
      session.action === 'sow_crop'
        ? {
            command: 'sow_crop',
            ...base,
            hectares: (data.hectares as number) ?? null,
            variety: (data.variety as string) ?? null,
          }
        : {
            command: 'harvest_crop',
            ...base,
            yieldKg: (data.yield_kg as number) ?? null,
            yieldKgPerHa: (data.yield_kg_per_ha as number) ?? null,
            humidity_pct: (data.humidity_pct as number) ?? null,
            loads: (data.loads as Array<Record<string, unknown>>) ?? null,
          };

    const settings = await userRepository.getSettings(session.user_id as never);
    const response = await domainRouter.routeCommand(
      cmd as never,
      session.user_id as never,
      user,
      settings,
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
    if (pending && (pending as { command?: string }).command === session.action &&
        !(pending as { nextInQueue?: unknown[] }).nextInQueue?.length) {
      pendingActStore.clear(session.phone);
      console.log('[FORM] pending consumido por submit');
    }

    console.log(`[FORM] submitted action=${session.action} user=${session.user_id}`);
    return { ok: true, message: fullText };
  });
}
