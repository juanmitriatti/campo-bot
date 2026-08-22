/**
 * Renderers de query_observations, uno por vista.
 *
 * Observaciones era el único de los 8 dominios de consulta sin archivo de
 * renderers (los otros tienen entre 8 y 10): respondía siempre con la misma
 * lista de 15 notas, sin agregados ni ranking. Acá se le da el mismo juego
 * mínimo que al resto.
 */

export interface ObservationRow {
  observation_text: string;
  observation_date: Date | string;
  category: string | null;
  plot_name: string | null;
  field_name: string | null;
}

export interface ObservationAggRow {
  bucket: string;
  n: number;
}

export interface ObservationRenderCtx {
  /** "agosto 2026", "semana pasada", "Todo el historial". */
  rangeLabel: string;
  /** " — lote Norte, \"pulgón\"" o vacío. */
  scope: string;
}

const CATEGORY_EMOJI: Record<string, string> = {
  sanidad: '🐛',
  malezas: '🌿',
  nutricion: '🧪',
  fenologia: '🌱',
  clima: '🌦️',
  general: '📝',
};

function catEmoji(c: string | null | undefined): string {
  return CATEGORY_EMOJI[String(c ?? 'general').toLowerCase()] ?? '📝';
}

function shortDate(d: Date | string): string {
  return new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

function where(r: ObservationRow): string {
  if (r.plot_name) return ` [${r.plot_name}]`;
  if (r.field_name) return ` [${r.field_name}]`;
  return '';
}

function clip(text: string, max = 150): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Mensaje cuando no hay nada — enseña cómo cargar una nota. */
export function renderObservationsEmpty(ctx: ObservationRenderCtx): string {
  return `📝 No encontré observaciones${ctx.scope}.\n\n`
    + 'Para anotar una, decime por ejemplo: *"anotá que apareció pulgón en la loma"*.';
}

export function renderObservationsDetail(
  rows: ObservationRow[],
  ctx: ObservationRenderCtx,
  limit: number,
): string {
  const lines = rows.map(r => `${catEmoji(r.category)} ${shortDate(r.observation_date)}${where(r)} — ${clip(r.observation_text)}`);
  const more = rows.length >= limit
    ? `\n_Mostrando ${limit}. Filtrá por lote, categoría o período para acotar._`
    : '';
  return `📝 *Observaciones${ctx.scope}*\n📅 ${ctx.rangeLabel}\n${lines.join('\n')}${more}`;
}

export function renderObservationsLast(rows: ObservationRow[], ctx: ObservationRenderCtx): string {
  const r = rows[0];
  const loc = where(r).trim();
  return `📝 *Última observación${ctx.scope}*\n`
    + `${catEmoji(r.category)} ${shortDate(r.observation_date)}${loc ? ` ${loc}` : ''}\n`
    + `_${clip(r.observation_text, 400)}_`;
}

export function renderObservationsAggregate(
  rows: ObservationAggRow[],
  ctx: ObservationRenderCtx,
  groupBy: string,
): string {
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const GROUP_LABEL: Record<string, string> = {
    category: 'categoría', plot: 'lote', field: 'campo', month: 'mes',
  };
  const lines = rows.map(r => {
    const pct = total > 0 ? Math.round((Number(r.n) / total) * 100) : 0;
    const emoji = groupBy === 'category' ? `${catEmoji(r.bucket)} ` : '';
    return `• ${emoji}${r.bucket}: *${r.n}* (${pct}%)`;
  });
  return `📝 *Observaciones por ${GROUP_LABEL[groupBy] ?? groupBy}${ctx.scope}*\n📅 ${ctx.rangeLabel}\n`
    + `${lines.join('\n')}\n━━━━━━━━━━━━━━\n*Total: ${total}*`;
}

export function renderObservationsTopLocations(
  rows: ObservationAggRow[],
  ctx: ObservationRenderCtx,
): string {
  const lines = rows.map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} *${r.bucket}* — ${r.n} nota${Number(r.n) === 1 ? '' : 's'}`;
  });
  return `📝 *Dónde anotaste más${ctx.scope}*\n📅 ${ctx.rangeLabel}\n${lines.join('\n')}`;
}
