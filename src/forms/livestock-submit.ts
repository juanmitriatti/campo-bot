// Commit del alta de hacienda con varias categorías (Flow v2): TODAS las filas en
// una transacción y con un solo claim del token, o ninguna. Cada fila se valida
// y se registra por el MISMO camino que el formulario simple.
import { pool, withTransaction } from '../config/db.js';
import { formSessionService, type FormSessionRow } from '../services/form-session.service.js';
import { domainRouter, userRepository, pendingActStore, applySideEffects } from '../services/message-pipeline.js';
import { buildFormCommand } from './form-commands.js';
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

const DUPLICATE = '⚠️ Parte de esto ya se cargó por el chat. No lo dupliqué: seguí contestando por acá o escribí *cancelar*.';
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
  // Flow ofrecido en lugar de la cola: tiene que seguir la cola ENTERA.
  const batchIntact = !prefill._batch || (
    (pending?.data as Record<string, unknown> | undefined)?.__batch === prefill._batch
    && 1 + (pending?.nextInQueue?.length ?? 0) === prefill._batchSize);
  if (!batchIntact || (session.had_pending && !pending)) {
    console.log('[FORM] rejected: el alta ya avanzó por chat');
    await formSessionService.claim(token);
    return { ok: false, status: 409, error: DUPLICATE };
  }

  const commands: Array<{ cmd: Record<string, unknown>; expectsExpense: boolean }> = [];
  for (const [i, row] of rows.entries()) {
    const prepared = await prepare(row.payload);
    if (!prepared.ok) {
      return rows.length > 1 ? { ...prepared, error: `Categoría ${i + 1}: ${prepared.error}` } : prepared;
    }
    const cmd = buildFormCommand('add_livestock', prepared.data, prepared.refs) as Record<string, unknown>;
    commands.push({ cmd, ...applyLivestockExtra(cmd, row.extra) });
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

  // La pregunta que este formulario contesta se cierra; lo que estaba en cola
  // detrás sigue. El batch es la cola entera, así que no deja nada.
  const answered = !!pending && (!!prefill._batch
    || (pending.command === 'add_livestock' && (!!session.had_pending || !pending.nextInQueue?.length)));
  const leftover: Queued[] = answered && !prefill._batch ? pending!.nextInQueue ?? [] : [];
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
    // "Sin precio" cancela todo lo pendiente: solo si no hay otra cosa en cola.
    if (leftover.length === 0) {
      response.interactive = { type: 'buttons', body: String(first.askPrompt), buttons: [{ id: 'cancel_action', title: 'Sin precio' }] };
    } else {
      response.messages = [...bodies, String(first.askPrompt)];
    }
  } else if (responses.length === 1 && responses[0].interactive) {
    response.messages = [];
    response.interactive = { ...responses[0].interactive, body: bodies[0] } as HandlerResponse['interactive'];
  }
  console.log(`[FORM] submitted action=add_livestock filas=${commands.length} user=${userId} precios_pendientes=${priceAsks.length}`);
  return { ok: true, message: bodies.join('\n\n'), response };
}
