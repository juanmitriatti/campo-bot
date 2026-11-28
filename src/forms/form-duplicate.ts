// ¿Puede que esto ya se haya cargado mientras el formulario estaba abierto?
// (se contestó por chat la misma pregunta, o se mandó como mensaje). No se
// descarta: se PREGUNTA. Para sospechar tienen que coincidir la fecha y el
// lugar, además del dato; el mismo gasoil en otro lote es otro gasto.
import { pool } from '../config/db.js';
import { dismissButton } from '../middleware/dismiss-button.js';
import { formatDateAR } from '../utils/date.js';
import type { FormAction } from './form-definitions.js';
import type { ResolvedRefs } from './form-commands.js';
import { callbackPayloadStore } from '../middleware/callback-payload-store.js';
import type { HandlerResponse } from '../types/index.js';

const SINCE = '(SELECT created_at FROM form_sessions WHERE token = $1)';

const EVENT_TYPE: Record<string, string> = {
  spraying: 'spraying', fertilization: 'fertilization', tillage: 'tillage', irrigation: 'irrigation',
};
const EVENT_LABEL: Record<string, string> = {
  harvest: 'una cosecha', spraying: 'una fumigación',
  fertilization: 'una fertilización', tillage: 'una labranza', irrigation: 'un riego',
};

/** Descripción de lo que ya está cargado y puede ser lo mismo, o null. */
export async function findRecordSinceForm(
  token: string,
  userId: number,
  action: FormAction,
  data: Record<string, unknown>,
  refs: ResolvedRefs,
  /**
   * Lo que el formulario traía precargado del chat: si se contestó por chat y
   * después se corrigió un número en el formulario, el registro existe con el
   * valor ORIGINAL.
   */
  prefill: Record<string, unknown> = {},
): Promise<string | null> {
  const ar = (n: number) => n.toLocaleString('es-AR');
  const either = (key: string) => [data[key], prefill[key]].map(Number).filter(n => Number.isFinite(n) && n > 0);
  const lower = (...values: unknown[]) => values
    .filter((v): v is string => typeof v === 'string' && !!v.trim())
    .map(v => v.trim().toLowerCase());
  // Un registro sin lote es compatible con cualquiera.
  const plotId = refs.plot?.id ?? null;

  if (action === 'log_expense' || action === 'log_income') {
    const table = action === 'log_expense' ? 'expenses' : 'incomes';
    const dateColumn = action === 'log_expense' ? 'expense_date' : 'income_date';
    const currency = data.currency === 'USD' ? 'USD' : 'ARS';
    const { rows } = await pool.query(
      `SELECT amount::float AS amount, currency, category FROM ${table}
        WHERE (user_id = $2 OR plot_id = $7) AND deleted_at IS NULL AND created_at > ${SINCE}
          AND ${dateColumn} = $3::date
          AND ($7::int IS NULL OR plot_id IS NULL OR plot_id = $7)
          AND ((amount = ANY($4::numeric[]) AND currency = $5) OR LOWER(category) = ANY($6::text[]))
        ORDER BY id DESC LIMIT 1`,
      [token, userId, data.event_date, either('amount'), currency, lower(data.category, prefill.category), plotId],
    );
    const r = rows[0] as { amount: number; currency: string; category: string } | undefined;
    if (!r) return null;
    const money = r.currency === 'USD' ? `US$ ${ar(r.amount)}` : `$${ar(r.amount)}`;
    return `un ${action === 'log_expense' ? 'gasto' : 'ingreso'} de ${money} en ${r.category}`;
  }

  if (action === 'add_livestock') {
    const { rows } = await pool.query(
      `SELECT m.count, g.category FROM livestock_movements m
         JOIN livestock_groups g ON g.id = m.dest_group_id
        WHERE m.user_id = $2 AND m.movement_type = 'entrada' AND m.created_at > ${SINCE}
          AND m.movement_date = $3::date AND m.count = ANY($4::int[])
          AND LOWER(g.category::text) = LOWER($5) AND m.reverses_movement_id IS NULL
          AND ($6::int IS NULL OR g.plot_id IS NULL OR g.plot_id = $6)
        ORDER BY m.id DESC LIMIT 1`,
      [token, userId, data.event_date, either('count'), data.category, plotId],
    );
    const r = rows[0] as { count: number; category: string } | undefined;
    return r ? `un ingreso de ${r.count} ${r.category.toLowerCase()}` : null;
  }

  // Siembra: el handler ya reconoce la repetida (no la duplica, actualiza lo que
  // cambió); preguntar ofrecería un "Guardar igual" que no puede guardar nada.
  if (action === 'sow_crop') return null;

  const type = action === 'harvest_crop' ? 'harvest'
    : EVENT_TYPE[String(data.activity_type)];
  if (!type || !refs.plot) return null;
  // Labor: mismo producto (dos fumigaciones del día con productos distintos son
  // dos). Del lote, la haya cargado quien la haya cargado.
  const products = action === 'log_activity' ? lower(data.product, prefill.product) : [];
  const { rows } = await pool.query(
    `SELECT event_date FROM domain_events
      WHERE deleted_at IS NULL AND created_at > ${SINCE}
        AND event_type = $2 AND plot_id = $3 AND event_date = $4::date
        AND (cardinality($5::text[]) = 0 OR product IS NULL OR LOWER(product) = ANY($5::text[]))
      ORDER BY id DESC LIMIT 1`,
    [token, type, refs.plot.id, data.event_date, products],
  );
  if (rows.length === 0) return null;
  return `${EVENT_LABEL[type]} en ${refs.plot.name} del ${formatDateAR(String(data.event_date))}`;
}

const saveAnywayId = (cmd: Record<string, unknown>) =>
  `cmdtok_${callbackPayloadStore.set(JSON.stringify({ ...cmd, __confirmedByTap: true }))}`;

/** Varias filas de hacienda dudosas: un botón por fila (WhatsApp admite 3). */
export function duplicateRowsQuestion(rows: Array<{ what: string; cmd: Record<string, unknown> }>): HandlerResponse {
  if (rows.length === 1) return duplicateQuestion(rows[0].what, rows[0].cmd);
  const shown = rows.slice(0, 2);
  const rest = rows.length > 2 ? ` Si las otras también faltan, mandámelas por acá.` : '';
  return {
    messages: [],
    needsConfirmation: true,
    interactive: {
      type: 'buttons',
      body: `⚠️ Desde que abriste este formulario ya cargaste ${rows.map(r => r.what).join(' y ')}. ¿Son otros? Esos todavía no los guardé.${rest}`,
      buttons: [
        ...shown.map(r => ({ id: saveAnywayId(r.cmd), title: `Guardar ${r.cmd.count} ${String(r.cmd.category)}`.slice(0, 20) })),
        dismissButton('No, ya está', '👍 Listo, no lo cargué de nuevo. Lo que ya tenías registrado quedó como estaba.'),
      ],
    },
  };
}

/** Pregunta en vez de descartar: [Guardar igual] re-ejecuta el comando completo. */
export function duplicateQuestion(what: string, cmd: Record<string, unknown>): HandlerResponse {
  return {
    messages: [],
    needsConfirmation: true,
    interactive: {
      type: 'buttons',
      body: `⚠️ Desde que abriste este formulario ya cargaste ${what}. ¿Es otro registro? Todavía no guardé nada.`,
      buttons: [
        { id: saveAnywayId(cmd), title: 'Guardar igual' },
        dismissButton('No, ya está', '👍 Listo, no lo cargué de nuevo. Lo que ya tenías registrado quedó como estaba.'),
      ],
    },
  };
}
