import { formatDayShortAR } from '../../utils/date.js';
// --- Scouting query renderers ---
//
// Same shape as financial.handler.ts renderers. Receives raw rows + ctx,
// returns a HandlerResponse. Aggregation happens here so we can compose flexibly.

import type { HandlerResponse } from '../../types/index.js';

const SEV_LABELS = ['', 'ausente', 'leve', 'moderada', 'alta', 'severa'];
const MOISTURE_LABELS = ['', 'muy seco', 'seco', 'regular', 'húmedo', 'muy húmedo'];

export interface ScoutingRow {
  id: number;
  scouting_date: string | Date;
  plot_id: number;
  plot_name: string | null;
  field_name: string | null;
  crop: string | null;
  stage_code: string | null;
  weed_coverage_pct: string | number | null;
  weed_species: string[] | null;
  pest_species: string | null;
  pest_severity_1_5: number | null;
  pest_affected_pct: string | number | null;
  emergence_pct: string | number | null;
  plant_density_m2: string | number | null;
  soil_moisture_1_5: number | null;
  notes: string | null;
}

export interface ScoutingRenderCtx {
  rangeLabel: string;
  scope: string;
  isAll: boolean;
  filters: {
    plotName?: string | null;
    fieldName?: string | null;
    aggregateMetric?: string | null;
    sortBy?: string | null;
    sortDesc?: boolean;
    weedSpeciesAny?: string[] | null;
    pestSpecies?: string | null;
    stageCode?: string | null;
    stagePrefix?: string | null;
    hasPest?: boolean | null;
    hasWeeds?: boolean | null;
  };
}

function fmtDay(d: string | Date): string {
  return formatDayShortAR(d);
}

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Phenology stage ordering: VE < V1..V30 < VT < R1..R8 < Z21..Z99.
// Returns a comparable rank so "estadio más avanzado" can sort across crops.
function stageRank(stage: string | null): number | null {
  if (!stage) return null;
  const s = stage.toUpperCase().trim();
  if (s === 'VE') return 0;
  if (s === 'VT') return 50;
  const m = s.match(/^([VRZ])(\d+)$/);
  if (!m) return null;
  const [, letter, numStr] = m;
  const n = Number(numStr);
  if (letter === 'V') return n;                  // V1..V30 → 1..30
  if (letter === 'R') return 100 + n;            // R1..R8 → 101..108
  if (letter === 'Z') return 200 + n;            // Z21..Z99 → 221..299 (Zadoks, wheat/barley)
  return null;
}

function metricValue(r: ScoutingRow, metric: string): number | null {
  if (metric === 'weed_coverage_pct') return num(r.weed_coverage_pct);
  if (metric === 'pest_severity') return r.pest_severity_1_5;
  if (metric === 'emergence_pct') return num(r.emergence_pct);
  if (metric === 'plant_density_m2') return num(r.plant_density_m2);
  if (metric === 'soil_moisture') return r.soil_moisture_1_5;
  if (metric === 'stage' || metric === 'phenology') return stageRank(r.stage_code);
  return null;
}

function metricLabel(metric: string): string {
  return metric === 'weed_coverage_pct' ? 'cobertura de malezas (%)'
    : metric === 'pest_severity' ? 'severidad de plaga'
    : metric === 'emergence_pct' ? 'emergencia (%)'
    : metric === 'plant_density_m2' ? 'plantas/m²'
    : metric === 'soil_moisture' ? 'humedad de suelo'
    : metric === 'stage' || metric === 'phenology' ? 'estadio fenológico'
    : metric;
}

function metricUnit(metric: string, v: number, row?: ScoutingRow): string {
  if (metric === 'weed_coverage_pct' || metric === 'emergence_pct' || metric === 'pest_affected_pct') return `${v}%`;
  if (metric === 'pest_severity') return `${v}/5 (${SEV_LABELS[v] || ''})`;
  if (metric === 'soil_moisture') return `${v}/5 (${MOISTURE_LABELS[v] || ''})`;
  if (metric === 'plant_density_m2') return `${v} pl/m²`;
  if (metric === 'stage' || metric === 'phenology') return row?.stage_code || `rank ${v}`;
  return `${v}`;
}

function renderRowLine(r: ScoutingRow): string {
  const date = fmtDay(r.scouting_date);
  const plot = r.plot_name || '?';
  const parts: string[] = [];
  if (r.stage_code) parts.push(r.stage_code);
  const weedPct = num(r.weed_coverage_pct);
  if (weedPct != null) {
    const species = r.weed_species && r.weed_species.length > 0 ? ` ${r.weed_species.join('/')}` : '';
    parts.push(`${weedPct}% maleza${species}`);
  } else if (r.weed_species && r.weed_species.length > 0) {
    parts.push(r.weed_species.join('/'));
  }
  if (r.pest_species) {
    const sev = r.pest_severity_1_5 ? ` ${SEV_LABELS[r.pest_severity_1_5]}` : '';
    parts.push(`${r.pest_species}${sev}`);
  }
  const em = num(r.emergence_pct);
  if (em != null) parts.push(`${em}% emerg.`);
  const d = num(r.plant_density_m2);
  if (d != null) parts.push(`${d} pl/m²`);
  if (r.soil_moisture_1_5 != null) parts.push(`hum ${r.soil_moisture_1_5}/5`);
  const detail = parts.length ? ` — ${parts.join(' · ')}` : '';
  return `• ${date} *${plot}*${detail}`;
}

// --- detail: list rows (default) ---
export function renderScoutingDetail(rows: ScoutingRow[], ctx: ScoutingRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const lines = [`🔍 *Monitoreos${ctx.scope}* (${rows.length})`, `📅 ${ctx.rangeLabel}`];
  for (const r of rows.slice(0, 15)) lines.push(renderRowLine(r));
  if (rows.length > 15) lines.push(`… (${rows.length - 15} más)`);
  return { messages: [lines.join('\n')], suggestionKey: 'report_shown' };
}

// --- aggregate: counts + top weeds/pests + stage distribution ---
export function renderScoutingAggregate(rows: ScoutingRow[], ctx: ScoutingRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const lines = [`📊 *Resumen monitoreos${ctx.scope}* (${rows.length})`, `📅 ${ctx.rangeLabel}`];
  // Plots covered
  const plots = new Set(rows.map(r => r.plot_name).filter(Boolean));
  lines.push(`Lotes monitoreados: ${plots.size} (${[...plots].join(', ')})`);
  // Weeds
  const allWeeds = new Map<string, number>();
  for (const r of rows) {
    for (const w of r.weed_species || []) {
      const key = w.toLowerCase();
      allWeeds.set(key, (allWeeds.get(key) || 0) + 1);
    }
  }
  if (allWeeds.size > 0) {
    const top = [...allWeeds.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(`🌿 Malezas: ${top.map(([w, c]) => `${w} (${c})`).join(', ')}`);
  }
  // Pests
  const allPests = new Map<string, { count: number; maxSev: number }>();
  for (const r of rows) {
    if (r.pest_species) {
      const prev = allPests.get(r.pest_species) || { count: 0, maxSev: 0 };
      prev.count++;
      prev.maxSev = Math.max(prev.maxSev, r.pest_severity_1_5 || 0);
      allPests.set(r.pest_species, prev);
    }
  }
  if (allPests.size > 0) {
    const top = [...allPests.entries()].sort((a, b) => b[1].maxSev - a[1].maxSev);
    lines.push(`🐛 Plagas: ${top.map(([p, m]) => `${p} ${m.maxSev ? SEV_LABELS[m.maxSev] : ''}`.trim()).join(', ')}`);
  }
  // Stages
  const stages = new Map<string, number>();
  for (const r of rows) if (r.stage_code) stages.set(r.stage_code, (stages.get(r.stage_code) || 0) + 1);
  if (stages.size > 0) {
    const list = [...stages.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(`📐 Estadios: ${list.map(([s, c]) => `${s} (${c})`).join(', ')}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'report_shown' };
}

// --- max / min: single-line answer for "el más X" ---
export function renderScoutingExtreme(rows: ScoutingRow[], ctx: ScoutingRenderCtx, mode: 'max' | 'min'): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'weed_coverage_pct';
  const valid = rows.filter(r => metricValue(r, metric) != null);
  if (valid.length === 0) {
    return { messages: [`Ningún monitoreo${ctx.scope} tiene "${metricLabel(metric)}" cargado.`], suggestionKey: 'report_shown' };
  }
  valid.sort((a, b) => {
    const va = metricValue(a, metric)!;
    const vb = metricValue(b, metric)!;
    return mode === 'max' ? vb - va : va - vb;
  });
  const winner = valid[0];
  const v = metricValue(winner, metric)!;
  const isStage = metric === 'stage' || metric === 'phenology';
  const titleVerb = isStage ? (mode === 'max' ? 'Estadio más avanzado' : 'Estadio menos avanzado') : `${mode === 'max' ? 'Máxima' : 'Mínima'} ${metricLabel(metric)}`;
  const title = mode === 'max' ? `🔝 *${titleVerb}${ctx.scope}*` : `🔻 *${titleVerb}${ctx.scope}*`;
  const msg = `${title}\n${winner.plot_name} — ${metricUnit(metric, v, winner)} (${fmtDay(winner.scouting_date)})`;
  return { messages: [msg], suggestionKey: 'report_shown' };
}

// --- avg ---
export function renderScoutingAvg(rows: ScoutingRow[], ctx: ScoutingRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'weed_coverage_pct';
  const vals: number[] = [];
  for (const r of rows) {
    const v = metricValue(r, metric);
    if (v != null) vals.push(v);
  }
  if (vals.length === 0) {
    return { messages: [`No hay datos de "${metricLabel(metric)}"${ctx.scope}.`], suggestionKey: 'report_shown' };
  }
  const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
  const rounded = Math.round(avg * 10) / 10;
  return { messages: [`📈 *Promedio ${metricLabel(metric)}${ctx.scope}*: ${metricUnit(metric, rounded)} (${vals.length} monitoreos)`], suggestionKey: 'report_shown' };
}

// --- rank: top N by metric ---
export function renderScoutingRank(rows: ScoutingRow[], ctx: ScoutingRenderCtx, topN: number): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'weed_coverage_pct';
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
    lines.push(`• ${r.plot_name} (${fmtDay(r.scouting_date)}) — ${metricUnit(metric, v)}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'report_shown' };
}

// --- top_locations: agg by plot/field, max/avg/sum of metric ---
export function renderScoutingTopLocations(rows: ScoutingRow[], ctx: ScoutingRenderCtx, groupBy: 'plot' | 'field'): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'pest_severity';
  const key = groupBy === 'field' ? 'field_name' : 'plot_name';
  const map = new Map<string, { vals: number[]; count: number }>();
  for (const r of rows) {
    const k = (r as unknown as Record<string, string | null>)[key] || '(sin asignar)';
    const v = metricValue(r, metric);
    const e = map.get(k) || { vals: [], count: 0 };
    e.count++;
    if (v != null) e.vals.push(v);
    map.set(k, e);
  }
  // Rank by max value (most useful for plant health / pest pressure)
  const ranked = [...map.entries()]
    .map(([k, e]) => ({ k, max: e.vals.length ? Math.max(...e.vals) : 0, avg: e.vals.length ? e.vals.reduce((s, x) => s + x, 0) / e.vals.length : 0, count: e.count }))
    .sort((a, b) => b.max - a.max);
  const desc = ctx.filters.sortDesc !== false;
  if (!desc) ranked.reverse();
  const dimLabel = groupBy === 'field' ? 'campos' : 'lotes';
  const lines = [`🏆 *Top ${dimLabel} por ${metricLabel(metric)}${ctx.scope}*`];
  for (const r of ranked.slice(0, 10)) {
    lines.push(`• ${r.k} — max ${metricUnit(metric, r.max)} (avg ${Math.round(r.avg * 10) / 10}, ${r.count} monitoreos)`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'report_shown' };
}

// --- compare: 2 plots/fields side by side ---
export function renderScoutingCompare(rowsA: ScoutingRow[], rowsB: ScoutingRow[], labelA: string, labelB: string): HandlerResponse {
  const summarize = (rs: ScoutingRow[]) => {
    if (rs.length === 0) return 'sin monitoreos';
    const weedAvg = (rs.map(r => num(r.weed_coverage_pct)).filter(v => v != null) as number[]);
    const sevMax = Math.max(0, ...rs.map(r => r.pest_severity_1_5 || 0));
    const ems = (rs.map(r => num(r.emergence_pct)).filter(v => v != null) as number[]);
    const moistAvg = (rs.map(r => r.soil_moisture_1_5).filter(v => v != null) as number[]);
    const parts = [`${rs.length} monitoreos`];
    if (weedAvg.length) parts.push(`maleza avg ${Math.round((weedAvg.reduce((s, x) => s + x, 0) / weedAvg.length) * 10) / 10}%`);
    if (sevMax > 0) parts.push(`sev max ${sevMax}/5`);
    if (ems.length) parts.push(`emerg avg ${Math.round((ems.reduce((s, x) => s + x, 0) / ems.length) * 10) / 10}%`);
    if (moistAvg.length) parts.push(`hum ${Math.round((moistAvg.reduce((s, x) => s + x, 0) / moistAvg.length) * 10) / 10}/5`);
    return parts.join(' · ');
  };
  const msg = `📊 *Comparación monitoreos*\n• *${labelA}*: ${summarize(rowsA)}\n• *${labelB}*: ${summarize(rowsB)}`;
  return { messages: [msg], suggestionKey: 'report_shown' };
}

// --- Empty state: proactive listing of available species/stages ---
export function renderEmpty(ctx: ScoutingRenderCtx, available?: { weeds?: string[]; pests?: string[]; stages?: string[] }): HandlerResponse {
  // "No encontré ... que coincidan": el resultado vacío casi siempre viene de
  // un FILTRO (lote heredado, has_weeds, especie) — decir "no hay monitoreos"
  // a secas contradecía la lista de datos de abajo (reporte de prod Jul 2026:
  // "este mensaje no lo entiendo").
  let msg = `🔍 No encontré monitoreos que coincidan${ctx.scope} (${ctx.rangeLabel}).`;
  const hints: string[] = [];
  if (available) {
    if (available.weeds && available.weeds.length > 0) hints.push(`malezas: ${available.weeds.join(', ')}`);
    if (available.pests && available.pests.length > 0) hints.push(`plagas: ${available.pests.join(', ')}`);
    if (available.stages && available.stages.length > 0) hints.push(`estadios: ${available.stages.join(', ')}`);
  }
  if (hints.length > 0) {
    // La lista viene de una query SIN filtros — atribuirla, o lee como contradicción
    msg += `\n\nEn el total de tus monitoreos (todos los lotes, todo el historial) hay:\n${hints.join(' | ')}.`;
    msg += `\n\n💡 Probá ampliar la búsqueda: agregá *"en todos los lotes"* o pedime *"mostrame todos los monitoreos"*.`;
  } else {
    msg += `\n\nTodavía no registraste monitoreos. Mandame por ej: *"soja V3 con 15% rama negra en lote Norte"* y lo guardo estructurado.`;
  }
  return { messages: [msg], suggestionKey: 'report_shown' };
}
