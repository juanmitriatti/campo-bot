// --- Stock query renderers ---
// Same shape as financial / scouting / harvest renderers.

import type { HandlerResponse } from '../../types/index.js';

export interface StockRow {
  id: number;
  user_id: number;
  warehouse_id: number;
  name: string;
  category: string;
  current_quantity: string | number;
  unit: string;
  min_stock: string | number | null;
  warehouse_name: string | null;
  field_name: string | null;
  field_id: number | null;
  grade?: string | null;
  humidity_pct?: string | number | null;
}

export interface StockRenderCtx {
  scope: string;
  filters: {
    fieldName?: string | null;
    warehouseName?: string | null;
    category?: string | null;
    productSearch?: string | null;
    lowStockOnly?: boolean | null;
    aggregateMetric?: string | null;
    groupBy?: string | null;
    sortDesc?: boolean;
  };
}

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtQty(q: number, unit: string): string {
  return `${q.toLocaleString('es-AR', { maximumFractionDigits: 2 })} ${unit}`;
}

function isLow(r: StockRow): boolean {
  if (r.min_stock == null) return false;
  return Number(r.current_quantity) <= Number(r.min_stock);
}

function renderRowLine(r: StockRow, opts: { showCategory?: boolean; showWarehouse?: boolean } = {}): string {
  const parts: string[] = [];
  parts.push(`*${r.name}*`);
  parts.push(fmtQty(Number(r.current_quantity), r.unit));
  if (opts.showCategory) parts.push(r.category);
  if (opts.showWarehouse) parts.push(`${r.warehouse_name || '?'} (${r.field_name || '?'})`);
  if (r.min_stock != null) {
    const lowIcon = isLow(r) ? ' 🔴' : '';
    parts.push(`mín ${Number(r.min_stock).toLocaleString('es-AR')} ${r.unit}${lowIcon}`);
  }
  return `• ${parts.join(' · ')}`;
}

// --- detail: list rows (default) ---
export function renderStockDetail(rows: StockRow[], ctx: StockRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const showCategory = !ctx.filters.category;
  const showWarehouse = !ctx.filters.warehouseName;
  const title = ctx.filters.lowStockOnly ? `🔴 *Stock bajo${ctx.scope}*` : `📦 *Stock${ctx.scope}*`;
  const lines = [`${title} (${rows.length} productos)`];
  for (const r of rows.slice(0, 20)) lines.push(renderRowLine(r, { showCategory, showWarehouse }));
  if (rows.length > 20) lines.push(`… (${rows.length - 20} más)`);

  // Totals by unit (a real summary line, even when units differ)
  const byUnit = new Map<string, number>();
  for (const r of rows) {
    const u = String(r.unit).toLowerCase();
    byUnit.set(u, (byUnit.get(u) || 0) + Number(r.current_quantity));
  }
  if (byUnit.size > 0) {
    const totals = [...byUnit.entries()]
      .map(([u, q]) => `${q.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ${u}`)
      .join(' · ');
    lines.push('');
    lines.push(`📊 *Total*: ${totals}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'stock_shown' };
}

// --- aggregate: breakdown by category and warehouse ---
export function renderStockAggregate(rows: StockRow[], ctx: StockRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const lines = [`📊 *Resumen stock${ctx.scope}* (${rows.length} productos)`];

  // By category — totals per unit
  const byCat = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const c = r.category;
    const u = String(r.unit).toLowerCase();
    const inner = byCat.get(c) || new Map<string, number>();
    inner.set(u, (inner.get(u) || 0) + Number(r.current_quantity));
    byCat.set(c, inner);
  }
  if (byCat.size > 0) {
    lines.push('');
    lines.push('🗂️ *Por categoría:*');
    for (const [c, units] of [...byCat.entries()].sort()) {
      const utotals = [...units.entries()]
        .map(([u, q]) => `${q.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ${u}`)
        .join(' / ');
      lines.push(`  • ${c}: ${utotals}`);
    }
  }

  // By warehouse — count of products
  const byWh = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.warehouse_name || '?'} (${r.field_name || '?'})`;
    byWh.set(k, (byWh.get(k) || 0) + 1);
  }
  if (byWh.size > 1) {
    lines.push('');
    lines.push('🏭 *Por depósito:*');
    for (const [k, n] of [...byWh.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  • ${k}: ${n} producto${n > 1 ? 's' : ''}`);
    }
  }

  // Low stock count
  const lowCount = rows.filter(isLow).length;
  if (lowCount > 0) {
    lines.push('');
    lines.push(`🔴 *${lowCount} producto${lowCount > 1 ? 's' : ''} bajo mínimo*`);
  }

  return { messages: [lines.join('\n')], suggestionKey: 'stock_shown' };
}

// --- max / min ---
export function renderStockExtreme(rows: StockRow[], ctx: StockRenderCtx, mode: 'max' | 'min'): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const metric = ctx.filters.aggregateMetric || 'quantity';
  // "Max stock" makes sense ONLY within a single unit family. If the user filtered to a category
  // or unit narrows down, we can rank directly. Otherwise we rank per unit.
  const byUnit = new Map<string, StockRow[]>();
  for (const r of rows) {
    const u = String(r.unit).toLowerCase();
    byUnit.set(u, [...(byUnit.get(u) || []), r]);
  }
  if (byUnit.size === 1) {
    const arr = [...byUnit.values()][0];
    arr.sort((a, b) => mode === 'max'
      ? Number(b.current_quantity) - Number(a.current_quantity)
      : Number(a.current_quantity) - Number(b.current_quantity));
    const w = arr[0];
    const title = mode === 'max' ? '🔝 *Producto con más stock*' : '🔻 *Producto con menos stock*';
    return { messages: [`${title}${ctx.scope}\n*${w.name}* — ${fmtQty(Number(w.current_quantity), w.unit)} · ${w.category} · ${w.warehouse_name} (${w.field_name})`], suggestionKey: 'stock_shown' };
  }
  // Multiple units → show top per unit (can't compare 100 lt vs 1000 kg)
  const title = mode === 'max' ? '🔝 *Más stock' : '🔻 *Menos stock';
  const lines = [`${title}${ctx.scope}* (por unidad — no se mezclan unidades)`];
  for (const [u, arr] of byUnit.entries()) {
    arr.sort((a, b) => mode === 'max'
      ? Number(b.current_quantity) - Number(a.current_quantity)
      : Number(a.current_quantity) - Number(b.current_quantity));
    const w = arr[0];
    lines.push(`• ${u}: *${w.name}* ${fmtQty(Number(w.current_quantity), w.unit)} (${w.warehouse_name})`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'stock_shown' };
}

// --- top_locations: rank by groupBy (category/warehouse/field/unit) ---
export function renderStockTopLocations(rows: StockRow[], ctx: StockRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const groupBy = ctx.filters.groupBy || 'category';
  const metric = ctx.filters.aggregateMetric || (groupBy === 'unit' ? 'quantity' : 'count');

  const keyOf = (r: StockRow): string => {
    if (groupBy === 'warehouse') return `${r.warehouse_name || '?'} (${r.field_name || '?'})`;
    if (groupBy === 'field') return r.field_name || '(sin campo)';
    if (groupBy === 'category') return r.category || '?';
    if (groupBy === 'unit') return String(r.unit).toLowerCase();
    if (groupBy === 'product') return r.name;
    return '?';
  };

  const map = new Map<string, { products: Set<string>; count: number; byUnit: Map<string, number> }>();
  for (const r of rows) {
    const k = keyOf(r);
    const e = map.get(k) || { products: new Set<string>(), count: 0, byUnit: new Map<string, number>() };
    e.products.add(r.name);
    e.count++;
    const u = String(r.unit).toLowerCase();
    e.byUnit.set(u, (e.byUnit.get(u) || 0) + Number(r.current_quantity));
    map.set(k, e);
  }

  const desc = ctx.filters.sortDesc !== false;
  const ranked = [...map.entries()].sort((a, b) => {
    if (metric === 'count') return desc ? b[1].count - a[1].count : a[1].count - b[1].count;
    // For quantity ranking with mixed units, sum the largest single-unit total
    const aMax = Math.max(0, ...a[1].byUnit.values());
    const bMax = Math.max(0, ...b[1].byUnit.values());
    return desc ? bMax - aMax : aMax - bMax;
  });

  const dimLabel = groupBy === 'warehouse' ? 'depósitos'
    : groupBy === 'field' ? 'campos'
    : groupBy === 'category' ? 'categorías'
    : groupBy === 'unit' ? 'unidades'
    : groupBy === 'product' ? 'productos'
    : groupBy;
  const lines = [`🏆 *Top ${dimLabel} por ${metric === 'count' ? 'cantidad de productos' : 'volumen'}${ctx.scope}*`];
  for (const [k, e] of ranked.slice(0, 10)) {
    const utotals = [...e.byUnit.entries()]
      .map(([u, q]) => `${q.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ${u}`)
      .join(' / ');
    lines.push(`• ${k}: ${e.count} producto${e.count > 1 ? 's' : ''} — ${utotals}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'stock_shown' };
}

// --- rank: top N rows by quantity ---
export function renderStockRank(rows: StockRow[], ctx: StockRenderCtx, topN: number): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const desc = ctx.filters.sortDesc !== false;
  const sorted = [...rows].sort((a, b) => desc
    ? Number(b.current_quantity) - Number(a.current_quantity)
    : Number(a.current_quantity) - Number(b.current_quantity));
  const lines = [`🏆 *Top ${topN} productos${desc ? ' por cantidad' : ' (menor a mayor)'}${ctx.scope}*`];
  for (const r of sorted.slice(0, topN)) {
    lines.push(`• ${fmtQty(Number(r.current_quantity), r.unit)} — *${r.name}* · ${r.category} · ${r.warehouse_name}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'stock_shown' };
}

// --- avg: average quantity per group (default by category) ---
export function renderStockAvg(rows: StockRow[], ctx: StockRenderCtx): HandlerResponse {
  if (rows.length === 0) return renderEmpty(ctx);
  const groupBy = ctx.filters.groupBy || 'category';
  const key = (r: StockRow): string => groupBy === 'warehouse' ? (r.warehouse_name || '?')
    : groupBy === 'field' ? (r.field_name || '?')
    : r.category;
  // Per (group, unit) avg
  const map = new Map<string, Map<string, { sum: number; n: number }>>();
  for (const r of rows) {
    const k = key(r);
    const u = String(r.unit).toLowerCase();
    const inner = map.get(k) || new Map<string, { sum: number; n: number }>();
    const e = inner.get(u) || { sum: 0, n: 0 };
    e.sum += Number(r.current_quantity);
    e.n++;
    inner.set(u, e);
    map.set(k, inner);
  }
  const dimLabel = groupBy === 'warehouse' ? 'depósito' : groupBy === 'field' ? 'campo' : 'categoría';
  const lines = [`📈 *Promedio de stock por ${dimLabel}${ctx.scope}*`];
  for (const [k, inner] of [...map.entries()].sort()) {
    const avgs = [...inner.entries()]
      .map(([u, e]) => `${(e.sum / e.n).toLocaleString('es-AR', { maximumFractionDigits: 1 })} ${u}`)
      .join(' / ');
    lines.push(`• ${k}: ${avgs}`);
  }
  return { messages: [lines.join('\n')], suggestionKey: 'stock_shown' };
}

// --- compare: 2 groups (warehouse/category/field) side by side ---
export function renderStockCompare(rowsA: StockRow[], rowsB: StockRow[], labelA: string, labelB: string): HandlerResponse {
  const summarize = (rs: StockRow[]) => {
    if (rs.length === 0) return 'sin productos';
    const byUnit = new Map<string, number>();
    for (const r of rs) {
      const u = String(r.unit).toLowerCase();
      byUnit.set(u, (byUnit.get(u) || 0) + Number(r.current_quantity));
    }
    const totals = [...byUnit.entries()].map(([u, q]) => `${q.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ${u}`).join(' / ');
    const lowN = rs.filter(isLow).length;
    return `${rs.length} producto${rs.length > 1 ? 's' : ''} · ${totals}${lowN > 0 ? ` · 🔴 ${lowN} bajo` : ''}`;
  };
  return { messages: [`📊 *Comparación stock*\n• *${labelA}*: ${summarize(rowsA)}\n• *${labelB}*: ${summarize(rowsB)}`], suggestionKey: 'stock_shown' };
}

// --- Empty state with proactive listing ---
export function renderEmpty(ctx: StockRenderCtx, available?: { categories?: string[]; warehouses?: string[]; products?: string[] }): HandlerResponse {
  let msg = ctx.filters.lowStockOnly
    ? `🟢 No hay productos bajo mínimo${ctx.scope}.`
    : `📦 No hay productos en stock${ctx.scope}.`;
  if (available) {
    const hints: string[] = [];
    if (available.categories?.length) hints.push(`categorías: ${available.categories.join(', ')}`);
    if (available.warehouses?.length) hints.push(`depósitos: ${available.warehouses.join(', ')}`);
    if (available.products?.length) hints.push(`productos: ${available.products.slice(0, 10).join(', ')}${available.products.length > 10 ? '…' : ''}`);
    if (hints.length) msg += `\n\nDatos cargados: ${hints.join(' | ')}.`;
  }
  return { messages: [msg], suggestionKey: 'stock_shown' };
}
