// --- Harvest-loads renderers ---
// Same shape as financial.handler.ts and scouting-renderers.ts.
// Receives raw rows + ctx, returns a HandlerResponse.

import type { HandlerResponse } from '../../types/index.js';

export interface HarvestRow {
  id: number;
  event_date: string | Date;
  plot_id: number | null;
  plot_name: string | null;
  field_name: string | null;
  crop: string | null;
  driver_name: string;
  weight_kg: string | number;
  destination: string | null;
  destinatario: string | null;
  truck_plate: string | null;
  humidity_pct: string | number | null;
  quality_metrics: Record<string, number> | null;
  notes: string | null;
}

export interface HarvestRenderCtx {
  rangeLabel: string;
  scope: string;
  isAll: boolean;
  filters: {
    plotName?: string | null;
    fieldName?: string | null;
    crop?: string | null;
    driverName?: string | null;
    destinatario?: string | null;
    truckPlate?: string | null;
    aggregateMetric?: string | null;
    groupBy?: string | null;
    sortDesc?: boolean;
  };
}

function fmtDay(d: string | Date): string {
  const date = new Date(d);
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
}

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtKg(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toLocaleString('es-AR', { maximumFractionDigits: 2 })} tn`;
  return `${kg.toLocaleString('es-AR', { maximumFractionDigits: 0 })} kg`;
}

function metricValue(r: HarvestRow, metric: string): number | null {
  if (metric === 'weight_kg') return num(r.weight_kg);
  if (metric === 'humidity_pct') return num(r.humidity_pct);
  if (metric === 'protein_pct') return num(r.quality_metrics?.protein_pct ?? null);
  if (metric === 'oil_pct') return num(r.quality_metrics?.oil_pct ?? null);
  if (metric === 'gluten_pct') return num(r.quality_metrics?.gluten_pct ?? null);
  if (metric === 'test_weight_kg_hl') return num(r.quality_metrics?.test_weight_kg_hl ?? null);
  return null;
}

function metricLabel(metric: string): string {
  return metric === 'weight_kg' ? 'peso (tn)'
    : metric === 'humidity_pct' ? 'humedad (%)'
    : metric === 'protein_pct' ? 'proteína (%)'
    : metric === 'oil_pct' ? 'aceite (%)'
    : metric === 'gluten_pct' ? 'gluten (%)'
    : metric === 'test_weight_kg_hl' ? 'PH (kg/hl)'
    : metric === 'count' ? 'viajes'
    : metric;
}

function metricUnit(metric: string, v: number): string {
  if (metric === 'weight_kg') return fmtKg(v);
  if (metric === 'humidity_pct' || metric === 'protein_pct' || metric === 'oil_pct' || metric === 'gluten_pct') return `${v.toLocaleString('es-AR', { maximumFractionDigits: 2 })}%`;
  if (metric === 'test_weight_kg_hl') return `${v.toLocaleString('es-AR', { maximumFractionDigits: 1 })} kg/hl`;
  if (metric === 'count') return `${v}`;
  return `${v}`;
}

function renderRowLine(r: HarvestRow, opts: { hidePlot?: boolean; hideCrop?: boolean; hideDriver?: boolean } = {}): string {
  const date = fmtDay(r.event_date);
  const parts: string[] = [];
  if (!opts.hideDriver) parts.push(r.driver_name);
  parts.push(fmtKg(Number(r.weight_kg)));
  if (!opts.hideCrop && r.crop) parts.push(r.crop);
  const dest = r.destinatario || r.destination;
  if (dest) parts.push(`→ ${dest}`);
  if (r.truck_plate) parts.push(`(${r.truck_plate})`);
  if (!opts.hidePlot && r.plot_name) parts.push(`[${r.plot_name}]`);
  const h = num(r.humidity_pct);
  if (h != null) parts.push(`${h}% hum`);
  if (r.quality_metrics) {
    const q = r.quality_metrics;
    if (q.oil_pct != null) parts.push(`aceite ${q.oil_pct}%`);
    if (q.protein_pct != null) parts.push(`prot ${q.protein_pct}%`);
    if (q.gluten_pct != null) parts.push(`glut ${q.gluten_pct}%`);
    if (q.test_weight_kg_hl != null) parts.push(`PH ${q.test_weight_kg_hl}`);
  }
  return `• ${date} — ${parts.join(' · ')}`;
}

// --- detail: list rows (default) ---
export function renderHarvestDetail(rows: HarvestRow[], ctx: HarvestRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const totalKg = rows.reduce((s, r) => s + Number(r.weight_kg), 0);
  const lines = [`🚛 *${rows.length} carga${rows.length > 1 ? 's' : ''}${ctx.scope}*`, `📅 ${ctx.rangeLabel}`];
  for (const r of rows.slice(0, 20)) lines.push(renderRowLine(r));
  if (rows.length > 20) lines.push(`… (${rows.length - 20} más)`);
  lines.push('');
  lines.push(`📊 *Total: ${fmtKg(totalKg)}*`);
  return { messages: [lines.join('\n')], suggestionKey: 'report_shown' };
}

// --- aggregate: counts + totals + breakdown by crop/destinatario/driver ---
export function renderHarvestAggregate(rows: HarvestRow[], ctx: HarvestRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const totalKg = rows.reduce((s, r) => s + Number(r.weight_kg), 0);
  const lines = [`📊 *Resumen cosechas${ctx.scope}* (${rows.length} cargas)`, `📅 ${ctx.rangeLabel}`];

  // Per-crop summary
  const byCrop = new Map<string, { kg: number; count: number }>();
  for (const r of rows) {
    const k = r.crop || '?';
    const e = byCrop.get(k) || { kg: 0, count: 0 };
    e.kg += Number(r.weight_kg);
    e.count++;
    byCrop.set(k, e);
  }
  if (byCrop.size > 0) {
    lines.push('');
    lines.push('🌾 *Por cultivo:*');
    for (const [c, e] of [...byCrop.entries()].sort((a, b) => b[1].kg - a[1].kg)) {
      lines.push(`  • ${c}: ${fmtKg(e.kg)} (${e.count} cargas)`);
    }
  }

  // Per-destinatario summary
  const byDest = new Map<string, { kg: number; count: number }>();
  for (const r of rows) {
    const k = r.destinatario || r.destination || '(sin destino)';
    const e = byDest.get(k) || { kg: 0, count: 0 };
    e.kg += Number(r.weight_kg);
    e.count++;
    byDest.set(k, e);
  }
  if (byDest.size > 0) {
    lines.push('');
    lines.push('📍 *Por destinatario:*');
    for (const [d, e] of [...byDest.entries()].sort((a, b) => b[1].kg - a[1].kg)) {
      lines.push(`  • ${d}: ${fmtKg(e.kg)} (${e.count})`);
    }
  }

  // Humidity avg if any
  const hums = rows.map(r => num(r.humidity_pct)).filter(v => v != null) as number[];
  if (hums.length > 0) {
    const avg = hums.reduce((s, x) => s + x, 0) / hums.length;
    lines.push('');
    lines.push(`💧 Humedad promedio: ${avg.toFixed(2)}% (${hums.length}/${rows.length} con dato)`);
  }

  lines.push('');
  lines.push(`📊 *Total: ${fmtKg(totalKg)}*`);
  return { messages: [lines.join('\n')], suggestionKey: 'report_shown' };
}

// --- max / min: single-line answer for "el más/menos X" ---
export function renderHarvestExtreme(rows: HarvestRow[], ctx: HarvestRenderCtx, mode: 'max' | 'min'): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'weight_kg';
  const valid = rows.filter(r => metricValue(r, metric) != null);
  if (valid.length === 0) {
    return { messages: [`Ninguna carga${ctx.scope} tiene "${metricLabel(metric)}" cargado.`], suggestionKey: 'report_shown' };
  }
  valid.sort((a, b) => {
    const va = metricValue(a, metric)!;
    const vb = metricValue(b, metric)!;
    return mode === 'max' ? vb - va : va - vb;
  });
  const winner = valid[0];
  const v = metricValue(winner, metric)!;
  const title = mode === 'max' ? `🔝 *Mayor ${metricLabel(metric)}${ctx.scope}*` : `🔻 *Menor ${metricLabel(metric)}${ctx.scope}*`;
  return { messages: [`${title}\n${metricUnit(metric, v)} — ${winner.driver_name} ${winner.crop ? `· ${winner.crop}` : ''} ${winner.destinatario ? `→ ${winner.destinatario}` : ''} (${fmtDay(winner.event_date)})`], suggestionKey: 'report_shown' };
}

// --- avg ---
export function renderHarvestAvg(rows: HarvestRow[], ctx: HarvestRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'humidity_pct';
  const vals = rows.map(r => metricValue(r, metric)).filter(v => v != null) as number[];
  if (vals.length === 0) {
    return { messages: [`No hay datos de "${metricLabel(metric)}"${ctx.scope}.`], suggestionKey: 'report_shown' };
  }
  const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
  return { messages: [`📈 *Promedio ${metricLabel(metric)}${ctx.scope}*: ${metricUnit(metric, Math.round(avg * 100) / 100)} (${vals.length} cargas)`], suggestionKey: 'report_shown' };
}

// --- rank: top N rows by metric (with sort direction) ---
export function renderHarvestRank(rows: HarvestRow[], ctx: HarvestRenderCtx, topN: number): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'weight_kg';
  const desc = ctx.filters.sortDesc !== false;
  const valid = rows.filter(r => metricValue(r, metric) != null).sort((a, b) => {
    const va = metricValue(a, metric)!;
    const vb = metricValue(b, metric)!;
    return desc ? vb - va : va - vb;
  });
  if (valid.length === 0) return renderEmpty(ctx);
  const title = desc ? `🏆 *Top ${topN} por ${metricLabel(metric)}${ctx.scope}*` : `📉 *Bottom ${topN} por ${metricLabel(metric)}${ctx.scope}*`;
  const lines = [title];
  for (const r of valid.slice(0, topN)) {
    const v = metricValue(r, metric)!;
    lines.push(`• ${metricUnit(metric, v)} — ${r.driver_name} ${r.crop ? `· ${r.crop}` : ''} ${r.destinatario ? `→ ${r.destinatario}` : ''} (${fmtDay(r.event_date)})`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'report_shown' };
}

// --- top_locations: rank by groupBy (plot/field/crop/driver/destinatario/truck_plate/date) ---
// IMPORTANT: weight_kg + count are SUMmed (extensive). protein/oil/gluten/humidity/test_weight are
// AVERAGEd (intensive — summing them is meaningless). Groups with no metric data are excluded.
export function renderHarvestTopLocations(rows: HarvestRow[], ctx: HarvestRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const groupBy = ctx.filters.groupBy || 'driver';
  const metric = ctx.filters.aggregateMetric || (groupBy === 'date' || groupBy === 'truck_plate' ? 'count' : 'weight_kg');
  const INTENSIVE_METRICS = new Set(['humidity_pct', 'protein_pct', 'oil_pct', 'gluten_pct', 'test_weight_kg_hl']);
  const isIntensive = INTENSIVE_METRICS.has(metric);

  const keyOf = (r: HarvestRow): string => {
    if (groupBy === 'plot') return r.plot_name || '(sin lote)';
    if (groupBy === 'field') return r.field_name || '(sin campo)';
    if (groupBy === 'crop') return r.crop || '(sin cultivo)';
    if (groupBy === 'driver') return r.driver_name;
    if (groupBy === 'destinatario') return r.destinatario || r.destination || '(sin destino)';
    if (groupBy === 'truck_plate') return r.truck_plate || '(sin patente)';
    if (groupBy === 'date') return fmtDay(r.event_date);
    return '?';
  };
  // Aggregate per group
  const map = new Map<string, { sum: number; count: number; vals: number[] }>();
  for (const r of rows) {
    const k = keyOf(r);
    const e = map.get(k) || { sum: 0, count: 0, vals: [] };
    e.count++;
    if (metric === 'count') {
      e.sum = e.count;
    } else {
      const v = metricValue(r, metric);
      if (v != null) {
        e.sum += v;
        e.vals.push(v);
      }
    }
    map.set(k, e);
  }
  // For intensive metrics: drop groups with zero data points (avoids "ACA: 0%" when ACA has no protein)
  // and rank by AVG, not SUM.
  const entries = [...map.entries()].filter(([, e]) => isIntensive ? e.vals.length > 0 : true);
  const desc = ctx.filters.sortDesc !== false;
  const ranked = entries.sort(([, a], [, b]) => {
    const aVal = isIntensive && a.vals.length > 0 ? a.sum / a.vals.length : a.sum;
    const bVal = isIntensive && b.vals.length > 0 ? b.sum / b.vals.length : b.sum;
    return desc ? bVal - aVal : aVal - bVal;
  });
  if (ranked.length === 0) {
    return { messages: [`Ningún registro${ctx.scope} tiene ${metricLabel(metric)} cargado.`], suggestionKey: 'report_shown' };
  }
  const dimLabel = groupBy === 'driver' ? 'chóferes'
    : groupBy === 'destinatario' ? 'destinatarios'
    : groupBy === 'crop' ? 'cultivos'
    : groupBy === 'plot' ? 'lotes'
    : groupBy === 'field' ? 'campos'
    : groupBy === 'truck_plate' ? 'patentes'
    : groupBy === 'date' ? 'días'
    : groupBy;
  const aggLabel = isIntensive ? `promedio ${metricLabel(metric)}` : metricLabel(metric);
  const lines = [`🏆 *Top ${dimLabel} por ${aggLabel}${ctx.scope}*`];
  for (const [k, e] of ranked.slice(0, 10)) {
    let display: string;
    let subDetail: string;
    if (metric === 'count') {
      display = `${e.count} viajes`;
      subDetail = '';
    } else if (isIntensive) {
      const avg = e.sum / e.vals.length;
      display = metricUnit(metric, Math.round(avg * 100) / 100);
      // Count cargas WITH the metric, not total in group (avoids "Cargill 21.5% (3 cargas)" when only 1 has aceite)
      subDetail = ` (${e.vals.length} carga${e.vals.length > 1 ? 's' : ''} con dato)`;
    } else {
      display = metricUnit(metric, e.sum);
      subDetail = ` (${e.count} carga${e.count > 1 ? 's' : ''})`;
    }
    lines.push(`• ${k}: ${display}${subDetail}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'report_shown' };
}

// --- compare: side-by-side two groups ---
export function renderHarvestCompare(rowsA: HarvestRow[], rowsB: HarvestRow[], labelA: string, labelB: string): HandlerResponse {
  const summarize = (rs: HarvestRow[]) => {
    if (rs.length === 0) return 'sin cargas';
    const totalKg = rs.reduce((s, r) => s + Number(r.weight_kg), 0);
    const hums = rs.map(r => num(r.humidity_pct)).filter(v => v != null) as number[];
    const parts = [`${rs.length} cargas`, fmtKg(totalKg)];
    if (hums.length) parts.push(`hum avg ${(hums.reduce((s, x) => s + x, 0) / hums.length).toFixed(2)}%`);
    return parts.join(' · ');
  };
  return { messages: [`📊 *Comparación cosechas*\n• *${labelA}*: ${summarize(rowsA)}\n• *${labelB}*: ${summarize(rowsB)}`], suggestionKey: 'report_shown' };
}

// --- volume: tn por cultivo (alias de top_locations group_by=crop, metric=weight) ---
export function renderHarvestVolume(rows: HarvestRow[], ctx: HarvestRenderCtx): HandlerResponse {
  return renderHarvestTopLocations(rows, { ...ctx, filters: { ...ctx.filters, groupBy: 'crop', aggregateMetric: 'weight_kg' } });
}

// --- Empty state ---
export function renderEmpty(ctx: HarvestRenderCtx, available?: { crops?: string[]; drivers?: string[]; destinatarios?: string[]; plots?: string[] }): HandlerResponse {
  let msg = `No hay cargas de cosecha${ctx.scope} (${ctx.rangeLabel}).`;
  if (available) {
    const hints: string[] = [];
    if (available.crops?.length) hints.push(`cultivos: ${available.crops.join(', ')}`);
    if (available.drivers?.length) hints.push(`chóferes: ${available.drivers.join(', ')}`);
    if (available.destinatarios?.length) hints.push(`destinatarios: ${available.destinatarios.join(', ')}`);
    if (available.plots?.length) hints.push(`lotes: ${available.plots.join(', ')}`);
    if (hints.length) msg += `\n\nDatos cargados: ${hints.join(' | ')}.`;
  }
  return { messages: [msg], suggestionKey: 'report_shown' };
}

/**
 * view='last' — la(s) carga(s) más reciente(s).
 *
 * Faltaba: `last` existía en actividades y lluvias pero no acá, así que "la
 * última carga" caía en `detail` y listaba todas. Muestra los kg acumulados
 * cuando se piden varias, que es lo que se quiere saber al preguntar por las
 * últimas N.
 */
export function renderHarvestLast(rows: HarvestRow[], ctx: HarvestRenderCtx, topN: number): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const sorted = [...rows]
    .sort((a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime())
    .slice(0, topN);
  const title = topN === 1 ? `🚛 *Última carga${ctx.scope}*` : `🚛 *Últimas ${topN} cargas${ctx.scope}*`;
  const lines = [title];
  for (const r of sorted) lines.push(renderRowLine(r));
  if (topN > 1) {
    const totalKg = sorted.reduce((s, r) => s + Number(r.weight_kg || 0), 0);
    lines.push('');
    lines.push(`⚖️ Total: ${totalKg.toLocaleString('es-AR')} kg (${(totalKg / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} tn)`);
  } else {
    const days = Math.floor((Date.now() - new Date(sorted[0].event_date).getTime()) / 86400000);
    lines.push('');
    lines.push(days === 0 ? '⏱️ Descargada hoy' : `⏱️ Hace ${days} día${days === 1 ? '' : 's'}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'report_shown' };
}
