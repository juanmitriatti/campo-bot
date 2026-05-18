// --- Rainfall query renderers ---
import type { HandlerResponse } from '../../types/index.js';

export interface RainfallRow {
  id: number;
  event_date: string | Date;
  mm: string | number;
  field_id: number | null;
  plot_id: number | null;
  field_name: string | null;
  plot_name: string | null;
}

export interface RainfallRenderCtx {
  scope: string;
  rangeLabel: string;
  isAll: boolean;
  filters: {
    fieldName?: string | null;
    plotName?: string | null;
    mmMin?: number | null;
    mmMax?: number | null;
    aggregateMetric?: string | null;
    groupBy?: string | null;
    sortDesc?: boolean;
  };
}

function fmtDay(d: string | Date): string {
  return new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
}
function fmtMm(n: number): string {
  return `${n.toLocaleString('es-AR', { maximumFractionDigits: 1 })} mm`;
}
function locLabel(r: RainfallRow): string {
  if (r.plot_name) return `${r.field_name || ''}/${r.plot_name}`;
  return r.field_name || '?';
}
function renderRowLine(r: RainfallRow): string {
  return `• ${fmtDay(r.event_date)} — ${fmtMm(Number(r.mm))} · ${locLabel(r)}`;
}

export function renderRainfallDetail(rows: RainfallRow[], ctx: RainfallRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const total = rows.reduce((s, r) => s + Number(r.mm), 0);
  const lines = [`🌧️ *Lluvias${ctx.scope}* (${rows.length} eventos)`, `📅 ${ctx.rangeLabel}`];
  for (const r of rows.slice(0, 25)) lines.push(renderRowLine(r));
  if (rows.length > 25) lines.push(`… (${rows.length - 25} más)`);
  lines.push('');
  lines.push(`📊 *Total: ${fmtMm(total)}*`);
  return { messages: [lines.join('\n')], suggestionKey: 'rainfall_shown' };
}

export function renderRainfallAggregate(rows: RainfallRow[], ctx: RainfallRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const total = rows.reduce((s, r) => s + Number(r.mm), 0);
  const lines = [`📊 *Resumen lluvias${ctx.scope}*`, `📅 ${ctx.rangeLabel}`];
  lines.push('');
  lines.push(`💧 *Total: ${fmtMm(total)}* (${rows.length} eventos)`);
  if (rows.length > 0) {
    const avg = total / rows.length;
    lines.push(`📈 Promedio por evento: ${fmtMm(avg)}`);
    const max = Math.max(...rows.map(r => Number(r.mm)));
    lines.push(`🔝 Máximo evento: ${fmtMm(max)}`);
  }
  // Por campo
  const byField = new Map<string, { mm: number; n: number }>();
  for (const r of rows) {
    const k = r.field_name || '?';
    const e = byField.get(k) || { mm: 0, n: 0 };
    e.mm += Number(r.mm); e.n++;
    byField.set(k, e);
  }
  if (byField.size > 1) {
    lines.push('');
    lines.push('📍 *Por campo:*');
    for (const [k, e] of [...byField.entries()].sort((a, b) => b[1].mm - a[1].mm)) {
      lines.push(`  • ${k}: ${fmtMm(e.mm)} (${e.n} eventos)`);
    }
  }
  return { messages: [lines.join('\n')], suggestionKey: 'rainfall_shown' };
}

export function renderRainfallExtreme(rows: RainfallRow[], ctx: RainfallRenderCtx, mode: 'max' | 'min'): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const sorted = [...rows].sort((a, b) => mode === 'max'
    ? Number(b.mm) - Number(a.mm)
    : Number(a.mm) - Number(b.mm));
  const w = sorted[0];
  const title = mode === 'max' ? '🔝 *Lluvia más fuerte' : '🔻 *Lluvia más leve';
  return { messages: [`${title}${ctx.scope}*\n${fmtMm(Number(w.mm))} — ${fmtDay(w.event_date)} · ${locLabel(w)}`], suggestionKey: 'rainfall_shown' };
}

export function renderRainfallAvg(rows: RainfallRow[], ctx: RainfallRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const vals = rows.map(r => Number(r.mm));
  const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
  return { messages: [`📈 *Promedio mm por evento${ctx.scope}*: ${fmtMm(avg)} (${vals.length} eventos)`], suggestionKey: 'rainfall_shown' };
}

export function renderRainfallTopLocations(rows: RainfallRow[], ctx: RainfallRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const groupBy = ctx.filters.groupBy || 'field';
  const metric = ctx.filters.aggregateMetric || 'mm';
  const keyOf = (r: RainfallRow): string => {
    if (groupBy === 'plot') return r.plot_name ? `${r.field_name || ''}/${r.plot_name}` : (r.field_name ? `${r.field_name} (sin lote)` : '?');
    if (groupBy === 'field') return r.field_name || '(sin campo)';
    if (groupBy === 'month') {
      const d = new Date(r.event_date);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    return '?';
  };
  const map = new Map<string, { mm: number; n: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    const e = map.get(k) || { mm: 0, n: 0 };
    e.mm += Number(r.mm); e.n++;
    map.set(k, e);
  }
  const desc = ctx.filters.sortDesc !== false;
  const ranked = [...map.entries()].sort((a, b) => {
    if (metric === 'count') return desc ? b[1].n - a[1].n : a[1].n - b[1].n;
    return desc ? b[1].mm - a[1].mm : a[1].mm - b[1].mm;
  });
  if (groupBy === 'month') ranked.sort((a, b) => a[0].localeCompare(b[0])); // chronological
  const dimLabel = groupBy === 'plot' ? 'lotes' : groupBy === 'field' ? 'campos' : 'meses';
  const lines = [`🏆 *${groupBy === 'month' ? 'Acumulado por mes' : `Top ${dimLabel} por ${metric === 'count' ? 'eventos' : 'mm'}`}${ctx.scope}*`];
  for (const [k, e] of ranked.slice(0, 15)) {
    lines.push(`• ${k}: ${fmtMm(e.mm)} (${e.n} evento${e.n > 1 ? 's' : ''})`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'rainfall_shown' };
}

export function renderRainfallRank(rows: RainfallRow[], ctx: RainfallRenderCtx, topN: number): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const desc = ctx.filters.sortDesc !== false;
  const sorted = [...rows].sort((a, b) => desc ? Number(b.mm) - Number(a.mm) : Number(a.mm) - Number(b.mm));
  const lines = [`🏆 *Top ${topN} eventos${desc ? '' : ' (menor a mayor)'}${ctx.scope}*`];
  for (const r of sorted.slice(0, topN)) lines.push(renderRowLine(r));
  return { messages: [lines.join('\n')], suggestionKey: 'rainfall_shown' };
}

export function renderRainfallCompare(rowsA: RainfallRow[], rowsB: RainfallRow[], labelA: string, labelB: string): HandlerResponse {
  const summarize = (rs: RainfallRow[]) => {
    if (rs.length === 0) return 'sin lluvias';
    const total = rs.reduce((s, r) => s + Number(r.mm), 0);
    return `${fmtMm(total)} (${rs.length} eventos)`;
  };
  return { messages: [`📊 *Comparación lluvias*\n• *${labelA}*: ${summarize(rowsA)}\n• *${labelB}*: ${summarize(rowsB)}`], suggestionKey: 'rainfall_shown' };
}

export function renderRainfallLast(rows: RainfallRow[], ctx: RainfallRenderCtx, topN: number): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const sorted = [...rows].sort((a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime()).slice(0, topN);
  const title = topN === 1 ? `📅 *Última lluvia${ctx.scope}*` : `📅 *Últimas ${topN} lluvias${ctx.scope}*`;
  const lines = [title];
  for (const r of sorted) lines.push(renderRowLine(r));
  // Days since last
  if (topN === 1) {
    const last = sorted[0];
    const daysSince = Math.floor((Date.now() - new Date(last.event_date).getTime()) / (1000 * 60 * 60 * 24));
    lines.push('');
    lines.push(`⏱️ Hace ${daysSince} días sin lluvia${ctx.filters.fieldName || ctx.filters.plotName ? '' : ' acá'}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'rainfall_shown' };
}

export function renderRainfallMonthly(rows: RainfallRow[], ctx: RainfallRenderCtx): HandlerResponse {
  return renderRainfallTopLocations(rows, { ...ctx, filters: { ...ctx.filters, groupBy: 'month', aggregateMetric: 'mm' } });
}

export function renderEmpty(ctx: RainfallRenderCtx, available?: { fields?: string[]; plots?: string[] }): HandlerResponse {
  let msg = `🌧️ No hay lluvias registradas${ctx.scope} (${ctx.rangeLabel}).`;
  if (available) {
    const hints: string[] = [];
    if (available.fields?.length) hints.push(`campos: ${available.fields.join(', ')}`);
    if (available.plots?.length) hints.push(`lotes: ${available.plots.join(', ')}`);
    if (hints.length) msg += `\n\nDatos cargados: ${hints.join(' | ')}.`;
  }
  return { messages: [msg], suggestionKey: 'rainfall_shown' };
}
