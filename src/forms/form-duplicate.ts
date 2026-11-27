// ¿Ya se cargó esto mientras el formulario estaba abierto? (el usuario contestó
// por chat la misma pregunta, o la mandó como mensaje). Es la única razón para
// no guardar un formulario que llega tarde: antes bastaba con que la pregunta
// que lo acompañaba ya no estuviera, y se descartaba un registro que no existía.
import { pool } from '../config/db.js';
import { formatDateAR } from '../utils/date.js';
import type { FormAction } from './form-definitions.js';
import type { ResolvedRefs } from './form-commands.js';

const SINCE = '(SELECT created_at FROM form_sessions WHERE token = $1)';

const EVENT_TYPE: Record<string, string> = {
  spraying: 'spraying', fertilization: 'fertilization', tillage: 'tillage', irrigation: 'irrigation',
};
const EVENT_LABEL: Record<string, string> = {
  planting: 'una siembra', harvest: 'una cosecha', spraying: 'una fumigación',
  fertilization: 'una fertilización', tillage: 'una labranza', irrigation: 'un riego',
};

/** Descripción del registro ya cargado, o null si no hay ninguno igual. */
export async function findRecordSinceForm(
  token: string,
  userId: number,
  action: FormAction,
  data: Record<string, unknown>,
  refs: ResolvedRefs,
  /**
   * Lo que el formulario traía precargado del chat. Si se contestó por chat y
   * después se corrigió el número en el formulario, el registro ya existe con el
   * valor ORIGINAL: también cuenta.
   */
  prefill: Record<string, unknown> = {},
): Promise<string | null> {
  const ar = (n: number) => n.toLocaleString('es-AR');
  const either = (key: string) => [data[key], prefill[key]].map(Number).filter(n => Number.isFinite(n) && n > 0);

  if (action === 'log_expense' || action === 'log_income') {
    const table = action === 'log_expense' ? 'expenses' : 'incomes';
    const currency = data.currency === 'USD' ? 'USD' : 'ARS';
    // La categoría elegida o la que traía precargada: "$500.000 de semilla" no
    // es el "$500.000 de arrendamiento" cargado en el medio.
    const categories = [data.category, prefill.category]
      .filter((c): c is string => typeof c === 'string' && !!c.trim())
      .map(c => c.trim().toLowerCase());
    const { rows } = await pool.query(
      `SELECT amount::float AS amount, category FROM ${table}
        WHERE user_id = $2 AND deleted_at IS NULL AND created_at > ${SINCE}
          AND amount = ANY($3::numeric[]) AND currency = $4 AND LOWER(category) = ANY($5::text[])
        ORDER BY id DESC LIMIT 1`,
      [token, userId, either('amount'), currency, categories],
    );
    const r = rows[0] as { amount: number; category: string } | undefined;
    if (!r) return null;
    const money = currency === 'USD' ? `US$ ${ar(r.amount)}` : `$${ar(r.amount)}`;
    return `un ${action === 'log_expense' ? 'gasto' : 'ingreso'} de ${money} en ${r.category}`;
  }

  if (action === 'add_livestock') {
    const { rows } = await pool.query(
      `SELECT m.count, g.category FROM livestock_movements m
         JOIN livestock_groups g ON g.id = m.dest_group_id
        WHERE m.user_id = $2 AND m.movement_type = 'entrada' AND m.created_at > ${SINCE} AND m.count = ANY($3::int[])
          AND LOWER(g.category::text) = LOWER($4) AND m.reverses_movement_id IS NULL
        ORDER BY m.id DESC LIMIT 1`,
      [token, userId, either('count'), data.category],
    );
    const r = rows[0] as { count: number; category: string } | undefined;
    return r ? `un ingreso de ${r.count} ${r.category.toLowerCase()}` : null;
  }

  const type = action === 'sow_crop' ? 'planting'
    : action === 'harvest_crop' ? 'harvest'
    : EVENT_TYPE[String(data.activity_type)];
  if (!type || !refs.plot) return null;
  const { rows } = await pool.query(
    `SELECT event_date FROM domain_events
      WHERE user_id = $2 AND deleted_at IS NULL AND created_at > ${SINCE}
        AND event_type = $3 AND plot_id = $4 AND event_date = $5::date
      ORDER BY id DESC LIMIT 1`,
    [token, userId, type, refs.plot.id, data.event_date],
  );
  if (rows.length === 0) return null;
  return `${EVENT_LABEL[type]} en ${refs.plot.name} del ${formatDateAR(String(data.event_date))}`;
}

export function alreadyLoadedMessage(what: string): string {
  return `⚠️ Desde que abriste este formulario ya cargaste ${what}. No lo dupliqué. Si es otro registro, pedime «formulario» y cargalo de nuevo.`;
}
