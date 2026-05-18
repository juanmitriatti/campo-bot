// --- Livestock inventory renderers (groups view dispatch) ---
// Same shape as financial / scouting / harvest / stock renderers.

import type { HandlerResponse } from '../../types/index.js';

const LIVESTOCK_LABEL: Record<string, string> = {
  vaca: 'Vacas', vaquillona: 'Vaquillonas', ternero: 'Terneros', ternera: 'Terneras',
  novillo: 'Novillos', novillito: 'Novillitos', toro: 'Toros', torito: 'Toritos', buey: 'Bueyes',
};

export interface LivestockGroupRow {
  id: string;
  category: string;
  breed: string | null;
  count: number;
  avg_weight_kg: number | null;
  plot_name: string | null;
  field_name: string | null;
  corral_name: string | null;
  feedlot_name: string | null;
}

export interface LivestockRenderCtx {
  scope: string;
  filters: {
    fieldName?: string | null;
    plotName?: string | null;
    corralName?: string | null;
    category?: string | null;
    breed?: string | null;
    inFeedlot?: boolean | null;
    aggregateMetric?: string | null;
    groupBy?: string | null;
    sortDesc?: boolean;
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function fmtNum(n: number): string {
  return n.toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

function totalWeightKg(r: LivestockGroupRow): number {
  return (r.avg_weight_kg || 0) * (r.count || 0);
}

function metricValue(r: LivestockGroupRow, metric: string): number | null {
  if (metric === 'count') return r.count;
  if (metric === 'avg_weight_kg') return r.avg_weight_kg;
  if (metric === 'total_weight_kg') return totalWeightKg(r);
  return r.count;
}

function metricLabel(metric: string): string {
  return metric === 'count' ? 'cabezas'
    : metric === 'avg_weight_kg' ? 'peso promedio (kg)'
    : metric === 'total_weight_kg' ? 'peso total estimado (kg)'
    : metric;
}

function metricUnit(metric: string, v: number): string {
  if (metric === 'count') return `${Math.round(v)} cabezas`;
  if (metric === 'avg_weight_kg') return `${fmtNum(v)} kg`;
  if (metric === 'total_weight_kg') return `${Math.round(v).toLocaleString('es-AR')} kg`;
  return `${v}`;
}

function locationLabel(r: LivestockGroupRow): string {
  if (r.corral_name) return `Corral ${r.corral_name}${r.feedlot_name ? ` (${r.feedlot_name})` : ''}`;
  if (r.field_name && r.plot_name) return `${r.field_name} / ${r.plot_name}`;
  if (r.field_name) return r.field_name;
  return '—';
}

function renderRowLine(r: LivestockGroupRow): string {
  const label = LIVESTOCK_LABEL[r.category] || cap(r.category);
  const breed = r.breed ? ` ${r.breed}` : '';
  const weight = r.avg_weight_kg ? ` · ${r.avg_weight_kg} kg prom` : '';
  const tot = totalWeightKg(r);
  const totLbl = tot > 0 ? ` · ${Math.round(tot).toLocaleString('es-AR')} kg total` : '';
  return `• ${label}${breed}: *${r.count}* — ${locationLabel(r)}${weight}${totLbl}`;
}

// --- detail (default): list grouped by location ---
export function renderLivestockDetail(rows: LivestockGroupRow[], ctx: LivestockRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const totalCount = rows.reduce((s, r) => s + (r.count || 0), 0);
  const totalKg = rows.reduce((s, r) => s + totalWeightKg(r), 0);
  const lines = [`🐄 *Hacienda${ctx.scope}* — total *${totalCount} cabezas*${totalKg > 0 ? ` · ~${Math.round(totalKg).toLocaleString('es-AR')} kg` : ''}`];
  for (const r of rows.slice(0, 25)) lines.push(renderRowLine(r));
  if (rows.length > 25) lines.push(`… (${rows.length - 25} grupos más)`);
  return { messages: [lines.join('\n')], suggestionKey: 'livestock_shown' };
}

// --- aggregate: total + breakdown por categoría + por ubicación ---
export function renderLivestockAggregate(rows: LivestockGroupRow[], ctx: LivestockRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const totalKg = rows.reduce((s, r) => s + totalWeightKg(r), 0);
  const lines = [`📊 *Resumen hacienda${ctx.scope}* — total *${totalCount} cabezas*${totalKg > 0 ? ` · ~${Math.round(totalKg).toLocaleString('es-AR')} kg` : ''}`];

  // Por categoría
  const byCat = new Map<string, { count: number; kg: number; groups: number }>();
  for (const r of rows) {
    const e = byCat.get(r.category) || { count: 0, kg: 0, groups: 0 };
    e.count += r.count;
    e.kg += totalWeightKg(r);
    e.groups++;
    byCat.set(r.category, e);
  }
  if (byCat.size > 0) {
    lines.push('');
    lines.push('🐮 *Por categoría:*');
    for (const [c, e] of [...byCat.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const kg = e.kg > 0 ? ` (~${Math.round(e.kg).toLocaleString('es-AR')} kg)` : '';
      lines.push(`  • ${LIVESTOCK_LABEL[c] || cap(c)}: ${e.count} cabezas${kg}`);
    }
  }

  // Por ubicación
  const byLoc = new Map<string, number>();
  for (const r of rows) {
    byLoc.set(locationLabel(r), (byLoc.get(locationLabel(r)) || 0) + r.count);
  }
  if (byLoc.size > 1) {
    lines.push('');
    lines.push('📍 *Por ubicación:*');
    for (const [loc, n] of [...byLoc.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  • ${loc}: ${n} cabezas`);
    }
  }

  return { messages: [lines.join('\n')], suggestionKey: 'livestock_shown' };
}

// --- max / min ---
export function renderLivestockExtreme(rows: LivestockGroupRow[], ctx: LivestockRenderCtx, mode: 'max' | 'min'): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'count';
  const valid = rows.filter(r => metricValue(r, metric) != null && metricValue(r, metric)! > 0);
  if (valid.length === 0) return renderEmpty(ctx);
  valid.sort((a, b) => {
    const va = metricValue(a, metric)!;
    const vb = metricValue(b, metric)!;
    return mode === 'max' ? vb - va : va - vb;
  });
  const w = valid[0];
  const v = metricValue(w, metric)!;
  const title = mode === 'max' ? `🔝 *Mayor ${metricLabel(metric)}${ctx.scope}*` : `🔻 *Menor ${metricLabel(metric)}${ctx.scope}*`;
  return { messages: [`${title}\n${metricUnit(metric, v)} — ${LIVESTOCK_LABEL[w.category] || cap(w.category)} en ${locationLabel(w)}`], suggestionKey: 'livestock_shown' };
}

// --- avg ---
export function renderLivestockAvg(rows: LivestockGroupRow[], ctx: LivestockRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'avg_weight_kg';
  const groupBy = ctx.filters.groupBy;
  if (!groupBy) {
    const vals = rows.map(r => metricValue(r, metric)).filter(v => v != null && v > 0) as number[];
    if (vals.length === 0) return { messages: [`No hay datos${ctx.scope}.`] };
    // Weighted avg by count for avg_weight_kg
    if (metric === 'avg_weight_kg') {
      const totW = rows.reduce((s, r) => s + totalWeightKg(r), 0);
      const totC = rows.reduce((s, r) => s + (r.avg_weight_kg ? r.count : 0), 0);
      const avg = totC > 0 ? totW / totC : 0;
      return { messages: [`📈 *Peso promedio ponderado${ctx.scope}*: ${fmtNum(avg)} kg (${totC} cabezas con dato)`] };
    }
    const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
    return { messages: [`📈 *Promedio ${metricLabel(metric)}${ctx.scope}*: ${metricUnit(metric, avg)} (${vals.length} grupos)`] };
  }
  // Grouped avg
  const keyOf = (r: LivestockGroupRow): string =>
    groupBy === 'category' ? (LIVESTOCK_LABEL[r.category] || cap(r.category))
    : groupBy === 'field' ? (r.field_name || '?')
    : groupBy === 'plot' ? (r.plot_name || '?')
    : groupBy === 'corral' ? (r.corral_name || '?')
    : groupBy === 'breed' ? (r.breed || 'sin raza')
    : '?';
  const map = new Map<string, { weightedKg: number; head: number; vals: number[] }>();
  for (const r of rows) {
    const k = keyOf(r);
    const e = map.get(k) || { weightedKg: 0, head: 0, vals: [] };
    if (metric === 'avg_weight_kg' && r.avg_weight_kg) {
      e.weightedKg += r.avg_weight_kg * r.count;
      e.head += r.count;
    } else {
      const v = metricValue(r, metric);
      if (v != null && v > 0) e.vals.push(v);
    }
    map.set(k, e);
  }
  const lines = [`📈 *Promedio ${metricLabel(metric)} por ${groupBy}${ctx.scope}*`];
  for (const [k, e] of [...map.entries()].sort()) {
    if (metric === 'avg_weight_kg') {
      const avg = e.head > 0 ? e.weightedKg / e.head : 0;
      lines.push(`  • ${k}: ${fmtNum(avg)} kg (${e.head} cabezas)`);
    } else {
      const avg = e.vals.length > 0 ? e.vals.reduce((s, x) => s + x, 0) / e.vals.length : 0;
      lines.push(`  • ${k}: ${metricUnit(metric, avg)}`);
    }
  }
  return { messages: [lines.join('\n')], suggestionKey: 'livestock_shown' };
}

// --- top_locations / rank: sum metric per group, sort, top N ---
export function renderLivestockTopLocations(rows: LivestockGroupRow[], ctx: LivestockRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const groupBy = ctx.filters.groupBy || 'category';
  const metric = ctx.filters.aggregateMetric || 'count';
  const keyOf = (r: LivestockGroupRow): string =>
    groupBy === 'category' ? (LIVESTOCK_LABEL[r.category] || cap(r.category))
    : groupBy === 'field' ? (r.field_name || '(sin campo)')
    : groupBy === 'plot' ? (r.plot_name || '(sin lote)')
    : groupBy === 'corral' ? (r.corral_name || '(sin corral)')
    : groupBy === 'breed' ? (r.breed || 'sin raza')
    : '?';
  const map = new Map<string, { sum: number; head: number; groups: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    const v = metricValue(r, metric) || 0;
    const e = map.get(k) || { sum: 0, head: 0, groups: 0 };
    e.sum += v;
    e.head += r.count;
    e.groups++;
    map.set(k, e);
  }
  const desc = ctx.filters.sortDesc !== false;
  const ranked = [...map.entries()].sort((a, b) => desc ? b[1].sum - a[1].sum : a[1].sum - b[1].sum);
  const dimLabel = groupBy === 'category' ? 'categorías'
    : groupBy === 'field' ? 'campos'
    : groupBy === 'plot' ? 'lotes'
    : groupBy === 'corral' ? 'corrales'
    : groupBy === 'breed' ? 'razas'
    : groupBy;
  const lines = [`🏆 *Top ${dimLabel} por ${metricLabel(metric)}${ctx.scope}*`];
  for (const [k, e] of ranked.slice(0, 10)) {
    if (metric === 'count') {
      lines.push(`• ${k}: ${e.head} cabezas (${e.groups} grupo${e.groups > 1 ? 's' : ''})`);
    } else {
      lines.push(`• ${k}: ${metricUnit(metric, e.sum)} (${e.head} cabezas)`);
    }
  }
  return { messages: [lines.join('\n')], suggestionKey: 'livestock_shown' };
}

// --- rank: top N rows ---
export function renderLivestockRank(rows: LivestockGroupRow[], ctx: LivestockRenderCtx, topN: number): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'count';
  const desc = ctx.filters.sortDesc !== false;
  const sorted = [...rows].sort((a, b) => {
    const va = metricValue(a, metric) || 0;
    const vb = metricValue(b, metric) || 0;
    return desc ? vb - va : va - vb;
  });
  const lines = [`🏆 *Top ${topN} grupos por ${metricLabel(metric)}${ctx.scope}*`];
  for (const r of sorted.slice(0, topN)) {
    const v = metricValue(r, metric) || 0;
    lines.push(`• ${LIVESTOCK_LABEL[r.category] || cap(r.category)} en ${locationLabel(r)}: ${metricUnit(metric, v)}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'livestock_shown' };
}

// --- compare ---
export function renderLivestockCompare(rowsA: LivestockGroupRow[], rowsB: LivestockGroupRow[], labelA: string, labelB: string): HandlerResponse {
  const summarize = (rs: LivestockGroupRow[]) => {
    if (rs.length === 0) return 'sin grupos';
    const head = rs.reduce((s, r) => s + r.count, 0);
    const kg = rs.reduce((s, r) => s + totalWeightKg(r), 0);
    return `${head} cabezas (${rs.length} grupos)${kg > 0 ? ` · ~${Math.round(kg).toLocaleString('es-AR')} kg` : ''}`;
  };
  return { messages: [`📊 *Comparación hacienda*\n• *${labelA}*: ${summarize(rowsA)}\n• *${labelB}*: ${summarize(rowsB)}`], suggestionKey: 'livestock_shown' };
}

// --- empty ---
export function renderEmpty(ctx: LivestockRenderCtx, available?: { categories?: string[]; fields?: string[]; corrals?: string[] }): HandlerResponse {
  let msg = `🐄 No hay hacienda${ctx.scope}.`;
  if (available) {
    const hints: string[] = [];
    if (available.categories?.length) hints.push(`categorías: ${available.categories.join(', ')}`);
    if (available.fields?.length) hints.push(`campos: ${available.fields.join(', ')}`);
    if (available.corrals?.length) hints.push(`corrales: ${available.corrals.join(', ')}`);
    if (hints.length) msg += `\n\nDatos cargados: ${hints.join(' | ')}.`;
  }
  return { messages: [msg], suggestionKey: 'livestock_shown' };
}
