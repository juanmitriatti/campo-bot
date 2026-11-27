// Commit del alta de hacienda con varias categorías (Flow v2): TODAS las filas en
// una transacción y con un solo claim del token, o ninguna. Cada fila se valida
// y se registra por el MISMO camino que el formulario simple.
import { pool, withTransaction } from '../config/db.js';
import { formSessionService, type FormSessionRow } from '../services/form-session.service.js';
import { domainRouter, userRepository, pendingActStore, applySideEffects } from '../services/message-pipeline.js';
import { buildFormCommand } from './form-commands.js';
import { findRecordSinceForm, duplicateRowsQuestion } from './form-duplicate.js';
import { FORM_DEFINITIONS, validateFieldValue } from './form-definitions.js';
import { getTodayISO } from '../utils/date.js';
import { applyLivestockExtra, type LivestockRow } from './livestock-rows.js';
import type { PreparedSubmission } from './form-submit.service.js';
import type { PendingActivity } from '../middleware/pending-activities.js';
import type { HandlerResponse, User } from '../types/index.js';

export type LivestockSubmitResult =
  | { ok: true; message: string; response: HandlerResponse }
  | { ok: false; status: number; error: string; field?: string };

class Aborted extends Error {
  constructor(readonly result: LivestockSubmitResult) { super('alta abortada'); }
}

const PRICE_LINE = /\n\n(¿A cuánto fue la compra\?[^\n]*|⚖️ [^\n]*)/;

type Queued = NonNullable<PendingActivity['nextInQueue']>[number];

async function written(userId: number): Promise<{ movements: number; expenses: number }> {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM livestock_movements WHERE user_id = $1)::int AS movements,
            (SELECT count(*) FROM expenses WHERE user_id = $1)::int AS expenses`,
    [userId],
  );
  return rows[0] as { movements: number; expenses: number };
}

export async function submitLivestockRows(
  token: string,
  session: FormSessionRow,
  rows: LivestockRow[],
  user: User,
  prepare: (payload: Record<string, unknown>) => Promise<PreparedSubmission>,
): Promise<LivestockSubmitResult> {
  const userId = Number(session.user_id);
  const pending = pendingActStore.get(session.phone) as PendingActivity | undefined;
  const prefill = (session.prefill ?? {}) as { _batch?: string; _batchSize?: number };

  const commands: Array<{ cmd: Record<string, unknown>; expectsExpense: boolean }> = [];
  const skipped: Array<{ what: string; cmd: Record<string, unknown> }> = [];
  const weightField = FORM_DEFINITIONS.add_livestock.flowFields!.find(f => f.key === 'avg_weight_kg')!;
  for (const [i, row] of rows.entries()) {
    const weight = validateFieldValue(weightField, row.extra.avgWeightRaw, getTodayISO());
    if (weight.error) {
      console.log(`[FORM] rejected: fila ${i + 1} de hacienda con peso inválido`);
      return { ok: false, status: 422, error: rows.length > 1 ? `Categoría ${i + 1}: ${weight.error}` : weight.error };
    }
    const prepared = await prepare(row.payload);
    if (!prepared.ok) {
      return rows.length > 1 ? { ...prepared, error: `Categoría ${i + 1}: ${prepared.error}` } : prepared;
    }
    const cmd = buildFormCommand('add_livestock', prepared.data, prepared.refs) as Record<string, unknown>;
    const extra = applyLivestockExtra(cmd, row.extra);
    const loaded = await findRecordSinceForm(token, userId, 'add_livestock', prepared.data, prepared.refs,
      i === 0 ? session.prefill as Record<string, unknown> | undefined : undefined);
    if (loaded) {
      // Esa fila no se guarda sola: se saltea y se pregunta.
      console.log(`[FORM] [INTERCEPT] fila ${i + 1} de hacienda posible duplicado: se pregunta`);
      skipped.push({ what: loaded, cmd });
      continue;
    }
    commands.push({ cmd, ...extra });
  }

  // La pregunta que este formulario contesta se cierra; lo que estaba en cola
  // detrás sigue. El batch es la cola entera, así que no deja nada.
  // Por chat puede haber quedado delante la pregunta de precio de lo ya
  // contestado: las preguntas del lote se sacan estén donde estén en la cola
  // (antes volvían a dar de alta los animales que cargó el formulario).
  const chain: Queued[] = pending
    ? [pending as unknown as Queued, ...(pending.nextInQueue ?? [])].map(({ command, data, missing, askPrompt }) => ({ command, data, missing, askPrompt }))
    : [];
  const fromBatch = (q: Queued) => (q.data as Record<string, unknown> | undefined)?.__batch === prefill._batch;
  const answered = prefill._batch
    ? chain.some(fromBatch)
    : !!pending && pending.command === 'add_livestock' && (!!session.had_pending || !pending.nextInQueue?.length);
  const leftover: Queued[] = !answered ? [] : prefill._batch ? chain.filter(q => !fromBatch(q)) : chain.slice(1);
  if (commands.length === 0) {
    await formSessionService.claim(token);
    if (answered) {
      pendingActStore.clear(session.phone);
      const [first, ...rest] = leftover;
      if (first) applySideEffects({ setPendingActivity: { ...first, ...(rest.length ? { nextInQueue: rest } : {}) } } as never, session.phone);
      console.log(`[FORM] pending consumido por submit (en cola: ${leftover.length})`);
    }
    const asked = duplicateRowsQuestion(skipped);
    return { ok: true, message: `${asked.interactive?.body}\n\nRespondé con los botones en el chat.`, response: asked };
  }

  const settings = await userRepository.getSettings(session.user_id as never);
  let responses: HandlerResponse[];
  try {
    responses = await withTransaction(async () => {
      if (!(await formSessionService.claim(token))) {
        throw new Aborted({ ok: false, status: 409, error: '✅ Eso ya quedó registrado. No lo dupliqué.' });
      }
      const done: HandlerResponse[] = [];
      for (const [i, step] of commands.entries()) {
        const before = await written(userId);
        const r = await domainRouter.routeCommand(
          step.cmd as never, session.user_id as never, user, { ...settings, confirm_before_save: false } as typeof settings,
        );
        const after = await written(userId);
        const asks = r?.sideEffects?.setPendingActivity;
        const blocked = !r || !!r.sideEffects?.startFlow || (!!asks && asks.command !== 'set_livestock_price')
          || after.movements <= before.movements;
        const lostExpense = step.expectsExpense && after.expenses <= before.expenses;
        if (blocked || lostExpense) {
          const why = lostExpense ? 'No pude registrar el gasto.' : (r?.messages?.[0] || r?.interactive?.body || 'No se pudo registrar.');
          console.log(`[FORM] rejected: fila ${i + 1} de hacienda no se guardó (${lostExpense ? 'gasto' : 'alta'})`);
          throw new Aborted({ ok: false, status: 422, error: rows.length > 1 ? `Categoría ${i + 1}: ${why}` : why });
        }
        done.push(r!);
      }
      return done;
    });
  } catch (err) {
    if (err instanceof Aborted) return err.result;
    throw err;
  }

  if (answered) {
    pendingActStore.clear(session.phone);
    console.log(`[FORM] pending consumido por submit (en cola: ${leftover.length})`);
  }

  const priceAsks: Queued[] = responses.flatMap((r, i) => {
    const p = r.sideEffects?.setPendingActivity;
    if (!p) return [];
    const perKg = !!p.missing?.includes('quantity');
    const what = `${commands[i].cmd.count} ${String(commands[i].cmd.category)}`;
    return [{
      command: p.command,
      data: p.data,
      missing: p.missing ?? [],
      askPrompt: perKg
        ? `⚖️ ¿Cuántos kilos pesaron en total los ${what}? (el precio fue por kilo)`
        : `💰 ¿A cuánto fue la compra de ${what}? (precio por cabeza)`,
    } as Queued];
  });

  const bodies = responses.map(r => (r.interactive?.body ?? r.messages.join('\n')).replace(PRICE_LINE, ''));
  const response: HandlerResponse = { messages: bodies };
  const asks = [...leftover, ...priceAsks];
  if (asks.length > 0) {
    const [first, ...rest] = asks;
    applySideEffects({ setPendingActivity: { ...first, ...(rest.length ? { nextInQueue: rest } : {}) } } as never, session.phone);
    // "Sin precio" saltea esta pregunta: solo si no hay otra cosa en cola.
    if (leftover.length === 0) {
      response.interactive = { type: 'buttons', body: String(first.askPrompt), buttons: [{ id: 'lv_price_skip', title: 'Sin precio' }] };
    } else {
      response.messages = [...bodies, String(first.askPrompt)];
    }
  } else if (responses.length === 1 && responses[0].interactive) {
    response.messages = [];
    response.interactive = { ...responses[0].interactive, body: bodies[0] } as HandlerResponse['interactive'];
  }
  // Las filas dudosas se preguntan; es la única botonera de la respuesta (la
  // pregunta de precio, si la hay, queda como texto).
  if (skipped.length > 0) {
    const asked = duplicateRowsQuestion(skipped);
    const previous = response.interactive?.body;
    response.messages = [...bodies, ...(previous && !bodies.includes(previous) ? [previous] : [])];
    response.interactive = asked.interactive;
  }
  console.log(`[FORM] submitted action=add_livestock filas=${commands.length} user=${userId} precios_pendientes=${priceAsks.length}`);
  return { ok: true, message: bodies.join('\n\n'), response };
}
