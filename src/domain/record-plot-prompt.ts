/**
 * "¿A qué lote va?" de los registros que un mensaje con varias acciones guardó
 * sin lote — UNO POR UNO.
 *
 * Antes era una sola pregunta para todos ("Guardé 2 gastos a nivel campo. ¿A qué
 * lote los asigno?"): el gasoil y el arrendamiento terminaban en el mismo lote
 * aunque fueran de lugares distintos. Ahora cada registro se nombra y se
 * pregunta por separado; al contestar uno, se pregunta el siguiente.
 *
 * El botón es `bap2_<token>_<plotId>` (0 = todo el campo). El payload del token
 * lleva el registro actual y la cola de los que faltan (`__next`).
 */
import { pool } from '../config/db.js';
import { callbackPayloadStore } from '../middleware/callback-payload-store.js';
import { formatMoney } from '../utils/format-money.js';
import type { InteractiveMessage, UserId } from '../types/index.js';

export interface UnplacedRecord { kind: string; id: number; fieldId: number }

/** La lluvia es del campo: no se pregunta lote. */
const NEVER_ASK = new Set(['rainfall']);

const KIND_NOUN: Record<string, string> = {
  expense: 'este gasto', income: 'este ingreso', activity: 'esta actividad', observation: 'esta observación',
  scouting: 'este monitoreo', livestock: 'esta hacienda', stock_movement: 'este movimiento de stock',
};

async function describeRecord(r: UnplacedRecord, userId: UserId): Promise<string> {
  try {
    if (r.kind === 'expense' || r.kind === 'income') {
      const table = r.kind === 'expense' ? 'expenses' : 'incomes';
      const { rows } = await pool.query(`SELECT category, amount, currency FROM ${table} WHERE id = $1 AND user_id = $2`, [r.id, userId]);
      if (rows[0]) return `${rows[0].category} — ${formatMoney(Number(rows[0].amount), rows[0].currency ?? 'ARS')}`;
    }
    if (r.kind === 'activity') {
      const { rows } = await pool.query(`SELECT event_type, product FROM domain_events WHERE id = $1 AND user_id = $2`, [r.id, userId]);
      if (rows[0]) return [String(rows[0].event_type).replace(/_/g, ' '), rows[0].product].filter(Boolean).join(' — ');
    }
  } catch { /* la etiqueta es best-effort: cae al nombre genérico */ }
  return (KIND_NOUN[r.kind] ?? 'este registro').replace(/^est[ea] /, '');
}

/**
 * Pregunta por el PRIMER registro de la lista; los demás viajan en el botón.
 * null = no hay nada que preguntar (varios campos, un solo lote, solo lluvias).
 */
export async function buildRecordPlotPrompt(
  records: UnplacedRecord[],
  userId: UserId,
  progress?: { done: number; total: number },
): Promise<{ message: string; interactive: InteractiveMessage } | null> {
  const askable = records.filter(r => !NEVER_ASK.has(r.kind) && r.fieldId > 0);
  const [current, ...rest] = askable;
  if (!current) return null;

  const plotsRes = await pool.query(
    `SELECT id, name FROM plots WHERE field_id = $1 AND deleted_at IS NULL ORDER BY name`,
    [current.fieldId],
  );
  const plots = plotsRes.rows as Array<{ id: number; name: string }>;
  if (plots.length < 2) return rest.length > 0 ? buildRecordPlotPrompt(rest, userId, progress) : null;

  const fieldRes = await pool.query(`SELECT name FROM fields WHERE id = $1 AND deleted_at IS NULL`, [current.fieldId]);
  const fieldName = (fieldRes.rows[0]?.name as string) ?? 'el campo';
  const total = progress?.total ?? askable.length;
  const done = progress?.done ?? 0;
  const counter = total > 1 ? ` (${done + 1} de ${total})` : '';
  const label = await describeRecord(current, userId);
  const body = `📍 *${label}* quedó en *${fieldName}*${counter}. ¿A qué lote lo imputo?`;

  const token = callbackPayloadStore.set(Buffer.from(JSON.stringify({
    [current.kind]: [current.id],
    __next: rest,
    __progress: { done: done + 1, total },
  })).toString('base64url'));

  const rows = [
    ...plots.map(p => ({ id: `bap2_${token}_${p.id}`, title: p.name.slice(0, 24) })),
    { id: `bap2_${token}_0`, title: 'Todo el campo' },
  ];
  if (rows.length <= 3) {
    return { message: body, interactive: { type: 'buttons', body, buttons: rows.map(r => ({ id: r.id, title: r.title.slice(0, 20) })) } };
  }
  return {
    message: body,
    interactive: { type: 'list', body, buttonText: 'Elegir lote', sections: [{ title: 'Lotes', rows }] },
  };
}
