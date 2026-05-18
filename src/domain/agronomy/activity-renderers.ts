// --- Activity query renderers (siembras/fumigaciones/fertilizaciones/cosechas/labranza/riego) ---
// Same shape as financial / scouting / harvest / stock / livestock renderers.

import type { HandlerResponse } from '../../types/index.js';

const TYPE_LABEL: Record<string, string> = {
  planting: 'Siembra',
  spraying: 'Fumigación',
  fertilization: 'Fertilización',
  harvest: 'Cosecha',
  tillage: 'Labranza',
  irrigation: 'Riego',
};
const TYPE_ICON: Record<string, string> = {
  planting: '🌱', spraying: '🚿', fertilization: '🧪', harvest: '🌾', tillage: '🚜', irrigation: '💧',
};

export interface ActivityRow {
  id: number;
  event_type: string;
  event_date: string | Date;
  crop: string | null;
  product: string | null;
  product_type: string | null;
  quantity: string | number | null;
  unit: string | null;
  implement: string | null;
  notes: string | null;
  plot_id: number | null;
  plot_name: string | null;
  field_name: string | null;
  field_id: number | null;
}

export interface ActivityRenderCtx {
  scope: string;
  rangeLabel: string;
  isAll: boolean;
  filters: {
    plotName?: string | null;
    fieldName?: string | null;
    crop?: string | null;
    activityTypes?: string[] | null;
    productSearch?: string | null;
    aggregateMetric?: string | null;
    groupBy?: string | null;
    sortDesc?: boolean;
  };
}

function fmtDay(d: string | Date): string {
  const dt = new Date(d);
  return dt.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
}

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtQty(q: number, unit: string): string {
  return `${q.toLocaleString('es-AR', { maximumFractionDigits: 2 })} ${unit || ''}`.trim();
}

function rowLabel(r: ActivityRow): string {
  return `${TYPE_ICON[r.event_type] || '•'} ${TYPE_LABEL[r.event_type] || r.event_type}`;
}

function rowDetail(r: ActivityRow): string {
  const bits: string[] = [];
  if (r.crop) bits.push(r.crop);
  if (r.product) {
    const q = num(r.quantity);
    bits.push(q != null && r.unit ? `${r.product} ${fmtQty(q, r.unit)}` : r.product);
  } else if (num(r.quantity) != null && r.unit) {
    bits.push(fmtQty(num(r.quantity)!, r.unit!));
  }
  if (r.notes) bits.push(r.notes);
  return bits.join(' · ');
}

function renderRowLine(r: ActivityRow, opts: { hidePlot?: boolean } = {}): string {
  const plot = !opts.hidePlot && r.plot_name ? ` [${r.plot_name}]` : '';
  const detail = rowDetail(r);
  return `• ${fmtDay(r.event_date)} — ${rowLabel(r)}${detail ? ` — ${detail}` : ''}${plot}`;
}

// --- detail (default) ---
export function renderActivityDetail(rows: ActivityRow[], ctx: ActivityRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const hidePlot = !!ctx.filters.plotName;
  const title = `📋 *Actividades${ctx.scope}* (${rows.length})`;
  const lines = [title, `📅 ${ctx.rangeLabel}`];
  for (const r of rows.slice(0, 20)) lines.push(renderRowLine(r, { hidePlot }));
  if (rows.length > 20) lines.push(`… (${rows.length - 20} más)`);
  return { messages: [lines.join('\n')], suggestionKey: 'activities_shown' };
}

// --- aggregate: breakdown by activity_type, crop, plot ---
export function renderActivityAggregate(rows: ActivityRow[], ctx: ActivityRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const lines = [`📊 *Resumen actividades${ctx.scope}* (${rows.length})`, `📅 ${ctx.rangeLabel}`];

  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.event_type, (byType.get(r.event_type) || 0) + 1);
  if (byType.size > 0) {
    lines.push('');
    lines.push('🗂️ *Por tipo:*');
    for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${TYPE_ICON[t] || '•'} ${TYPE_LABEL[t] || t}: ${n}`);
    }
  }

  const byCrop = new Map<string, number>();
  for (const r of rows) if (r.crop) byCrop.set(r.crop, (byCrop.get(r.crop) || 0) + 1);
  if (byCrop.size > 0) {
    lines.push('');
    lines.push('🌾 *Por cultivo:*');
    for (const [c, n] of [...byCrop.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  • ${c}: ${n}`);
    }
  }

  const byPlot = new Map<string, number>();
  for (const r of rows) if (r.plot_name) byPlot.set(r.plot_name, (byPlot.get(r.plot_name) || 0) + 1);
  if (byPlot.size > 1) {
    lines.push('');
    lines.push('📍 *Por lote:*');
    for (const [p, n] of [...byPlot.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  • ${p}: ${n}`);
    }
  }

  // Totals by product (when there are application activities with quantities)
  const byProduct = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.product || num(r.quantity) == null || !r.unit) continue;
    const inner = byProduct.get(r.product) || new Map<string, number>();
    inner.set(r.unit, (inner.get(r.unit) || 0) + Number(r.quantity));
    byProduct.set(r.product, inner);
  }
  if (byProduct.size > 0) {
    lines.push('');
    lines.push('🧪 *Productos aplicados:*');
    for (const [p, units] of byProduct.entries()) {
      const totals = [...units.entries()].map(([u, q]) => `${q.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ${u}`).join(' / ');
      lines.push(`  • ${p}: ${totals}`);
    }
  }

  return { messages: [lines.join('\n')], suggestionKey: 'activities_shown' };
}

// --- max / min by quantity ---
export function renderActivityExtreme(rows: ActivityRow[], ctx: ActivityRenderCtx, mode: 'max' | 'min'): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const valid = rows.filter(r => num(r.quantity) != null && num(r.quantity)! > 0);
  if (valid.length === 0) return renderEmpty(ctx);
  valid.sort((a, b) => mode === 'max'
    ? Number(b.quantity) - Number(a.quantity)
    : Number(a.quantity) - Number(b.quantity));
  const w = valid[0];
  const title = mode === 'max' ? '🔝 *Mayor aplicación' : '🔻 *Menor aplicación';
  return { messages: [`${title}${ctx.scope}*\n${rowLabel(w)} — ${rowDetail(w)} (${fmtDay(w.event_date)}) ${w.plot_name ? `[${w.plot_name}]` : ''}`], suggestionKey: 'activities_shown' };
}

// --- avg of quantity ---
export function renderActivityAvg(rows: ActivityRow[], ctx: ActivityRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const byUnit = new Map<string, number[]>();
  for (const r of rows) {
    const q = num(r.quantity);
    if (q == null || !r.unit) continue;
    const u = r.unit;
    byUnit.set(u, [...(byUnit.get(u) || []), q]);
  }
  if (byUnit.size === 0) return { messages: [`No hay cantidades cargadas${ctx.scope}.`], suggestionKey: 'activities_shown' };
  const lines = [`📈 *Promedio por aplicación${ctx.scope}*`];
  for (const [u, vals] of byUnit.entries()) {
    const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
    lines.push(`  • ${avg.toLocaleString('es-AR', { maximumFractionDigits: 2 })} ${u} (${vals.length} actividades)`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'activities_shown' };
}

// --- top_locations: rank by group_by ---
export function renderActivityTopLocations(rows: ActivityRow[], ctx: ActivityRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const groupBy = ctx.filters.groupBy || 'plot';
  const metric = ctx.filters.aggregateMetric || 'count';
  const keyOf = (r: ActivityRow): string =>
    groupBy === 'plot' ? (r.plot_name || '(sin lote)')
    : groupBy === 'field' ? (r.field_name || '(sin campo)')
    : groupBy === 'crop' ? (r.crop || '(sin cultivo)')
    : groupBy === 'activity_type' ? (TYPE_LABEL[r.event_type] || r.event_type)
    : groupBy === 'product' ? (r.product || '(sin producto)')
    : '?';

  const map = new Map<string, { count: number; qtyByUnit: Map<string, number> }>();
  for (const r of rows) {
    const k = keyOf(r);
    const e = map.get(k) || { count: 0, qtyByUnit: new Map<string, number>() };
    e.count++;
    const q = num(r.quantity);
    if (q != null && r.unit) e.qtyByUnit.set(r.unit, (e.qtyByUnit.get(r.unit) || 0) + q);
    map.set(k, e);
  }
  const desc = ctx.filters.sortDesc !== false;
  const ranked = [...map.entries()].sort((a, b) => {
    if (metric === 'quantity') {
      const aQ = Math.max(0, ...a[1].qtyByUnit.values());
      const bQ = Math.max(0, ...b[1].qtyByUnit.values());
      return desc ? bQ - aQ : aQ - bQ;
    }
    return desc ? b[1].count - a[1].count : a[1].count - b[1].count;
  });
  const dimLabel = groupBy === 'plot' ? 'lotes'
    : groupBy === 'field' ? 'campos'
    : groupBy === 'crop' ? 'cultivos'
    : groupBy === 'activity_type' ? 'tipos'
    : groupBy === 'product' ? 'productos'
    : groupBy;
  const metricLbl = metric === 'quantity' ? 'cantidad aplicada' : 'cantidad de actividades';
  const lines = [`🏆 *Top ${dimLabel} por ${metricLbl}${ctx.scope}*`];
  for (const [k, e] of ranked.slice(0, 10)) {
    const qty = e.qtyByUnit.size > 0
      ? ' · ' + [...e.qtyByUnit.entries()].map(([u, q]) => `${q.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ${u}`).join(' / ')
      : '';
    lines.push(`• ${k}: ${e.count} actividades${qty}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'activities_shown' };
}

// --- rank: top N rows ---
export function renderActivityRank(rows: ActivityRow[], ctx: ActivityRenderCtx, topN: number): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'quantity';
  const desc = ctx.filters.sortDesc !== false;
  let sorted = [...rows];
  if (metric === 'quantity') {
    sorted = sorted.filter(r => num(r.quantity) != null).sort((a, b) => {
      const va = Number(a.quantity || 0);
      const vb = Number(b.quantity || 0);
      return desc ? vb - va : va - vb;
    });
  }
  const lines = [`🏆 *Top ${topN} actividades${desc ? ' por cantidad' : ' (menor a mayor)'}${ctx.scope}*`];
  for (const r of sorted.slice(0, topN)) lines.push(renderRowLine(r));
  return { messages: [lines.join('\n')], suggestionKey: 'activities_shown' };
}

// --- compare: 2 groups side by side ---
export function renderActivityCompare(rowsA: ActivityRow[], rowsB: ActivityRow[], labelA: string, labelB: string): HandlerResponse {
  const summarize = (rs: ActivityRow[]) => {
    if (rs.length === 0) return 'sin actividades';
    const byType = new Map<string, number>();
    for (const r of rs) byType.set(r.event_type, (byType.get(r.event_type) || 0) + 1);
    const typeBits = [...byType.entries()].map(([t, n]) => `${n} ${TYPE_LABEL[t] || t}`).join(' · ');
    return `${rs.length} actividades — ${typeBits}`;
  };
  return { messages: [`📊 *Comparación actividades*\n• *${labelA}*: ${summarize(rowsA)}\n• *${labelB}*: ${summarize(rowsB)}`], suggestionKey: 'activities_shown' };
}

// --- last: most recent N (sorted by date desc) ---
export function renderActivityLast(rows: ActivityRow[], ctx: ActivityRenderCtx, topN: number): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const sorted = [...rows].sort((a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime()).slice(0, topN);
  const title = topN === 1 ? `📅 *Última actividad${ctx.scope}*` : `📅 *Últimas ${topN} actividades${ctx.scope}*`;
  const lines = [title];
  for (const r of sorted) lines.push(renderRowLine(r));
  return { messages: [lines.join('\n')], suggestionKey: 'activities_shown' };
}

// --- timeline: chronological ordered for a single plot or crop ---
export function renderActivityTimeline(rows: ActivityRow[], ctx: ActivityRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const sorted = [...rows].sort((a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime());
  const lines = [`📅 *Timeline${ctx.scope}* (${rows.length} actividades, cronológico)`];
  for (const r of sorted.slice(0, 25)) lines.push(renderRowLine(r));
  if (sorted.length > 25) lines.push(`… (${sorted.length - 25} más)`);
  return { messages: [lines.join('\n')], suggestionKey: 'activities_shown' };
}

// --- Empty state with proactive listing ---
export function renderEmpty(ctx: ActivityRenderCtx, available?: { types?: string[]; crops?: string[]; plots?: string[]; products?: string[] }): HandlerResponse {
  let msg = `No hay actividades${ctx.scope} (${ctx.rangeLabel}).`;
  if (available) {
    const hints: string[] = [];
    if (available.types?.length) hints.push(`tipos: ${available.types.map(t => TYPE_LABEL[t] || t).join(', ')}`);
    if (available.crops?.length) hints.push(`cultivos: ${available.crops.join(', ')}`);
    if (available.plots?.length) hints.push(`lotes: ${available.plots.join(', ')}`);
    if (available.products?.length) hints.push(`productos: ${available.products.join(', ')}`);
    if (hints.length) msg += `\n\nDatos cargados: ${hints.join(' | ')}.`;
  }
  return { messages: [msg], suggestionKey: 'activities_shown' };
}
