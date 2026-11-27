// Alta de hacienda por WhatsApp Flow con varias categorías (nov 2026). Las reglas
// de cada fila son las del formulario base: acá solo se parte la respuesta en
// filas, se traduce la forma de precio y se arma la precarga.
import type { FormOptions } from './form-options.js';

export const LIVESTOCK_ROWS_GROUP = 'animals';
export const MAX_LIVESTOCK_ROWS = 5;

const ROW_KEYS = ['category', 'count', 'breed', 'unit_price', 'price_mode', 'avg_weight_kg'] as const;
const SHARED_KEYS = ['location', 'event_date', 'currency', 'notes'] as const;

export interface LivestockExtra { origin: string; priceMode: string; avgWeightKg: number | null }
export interface LivestockRow { payload: Record<string, unknown>; extra: LivestockExtra }

const filled = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== '';
const positive = (v: unknown): number | null => {
  const n = Number(v);
  return filled(v) && Number.isFinite(n) && n > 0 ? n : null;
};

/** Invernada se compra por kilo vivo; vientres y toros, por cabeza. */
export function defaultPriceMode(category: unknown): 'head' | 'kg' {
  return /^(ternero|ternera|novillo|novillito|vaquillona)/i.test(String(category ?? '')) ? 'kg' : 'head';
}

/** ¿Esta respuesta viene del Flow v2? (el form web y el conversacional no traen estas claves) */
export function isLivestockFlowPayload(payload: Record<string, unknown>): boolean {
  return 'origin' in payload || 'price_mode' in payload || LIVESTOCK_ROWS_GROUP in payload;
}

export function splitLivestockRows(payload: Record<string, unknown>): LivestockRow[] {
  const shared = Object.fromEntries(SHARED_KEYS.filter(k => k in payload).map(k => [k, payload[k]]));
  const extraRows = Array.isArray(payload[LIVESTOCK_ROWS_GROUP]) ? payload[LIVESTOCK_ROWS_GROUP] as Array<Record<string, unknown>> : [];
  const origin = String(payload.origin ?? '');
  return [payload, ...extraRows].map(row => ({
    payload: { ...shared, ...Object.fromEntries(['category', 'count', 'breed', 'unit_price'].filter(k => k in row).map(k => [k, row[k]])) },
    extra: { origin, priceMode: String(row.price_mode || 'head'), avgWeightKg: positive(row.avg_weight_kg) },
  }));
}

/**
 * Traduce la forma de precio al comando del handler. Devuelve si esta fila TIENE
 * que dejar un gasto (para verificar que se haya escrito).
 */
export function applyLivestockExtra(cmd: Record<string, unknown>, extra: LivestockExtra): { expectsExpense: boolean } {
  const key = cmd.unit_price_usd !== undefined ? 'usd' : 'ars';
  const price = positive(cmd[`unit_price_${key}`]);
  const count = Number(cmd.count);
  if (extra.avgWeightKg) {
    cmd.avg_weight_kg = extra.avgWeightKg;
    cmd.total_weight_kg = Math.round(extra.avgWeightKg * count * 100) / 100;
  }
  if (price === null) {
    // Compra sin precio: el alta se guarda y se pregunta una vez.
    if (extra.origin === 'compra') cmd.isPurchase = true;
    return { expectsExpense: false };
  }
  // Con precio es una compra, diga lo que diga el selector.
  cmd.isPurchase = true;
  if (extra.priceMode === 'kg') {
    delete cmd[`unit_price_${key}`];
    cmd[`price_per_kg_${key}`] = price;
    return { expectsExpense: extra.avgWeightKg !== null };
  }
  if (extra.priceMode === 'total') cmd[`unit_price_${key}`] = Math.round((price / count) * 100) / 100;
  return { expectsExpense: true };
}

/** Valores iniciales de los campos propios del Flow (filas, origen, forma de precio). */
export function livestockFlowInitial(prefill: Record<string, unknown>, options: FormOptions): Record<string, unknown> {
  const rows = (Array.isArray(prefill._rows) ? prefill._rows : [prefill]) as Array<Record<string, unknown>>;
  const pick = (list: 'livestock_categories' | 'breeds', value: unknown): string => {
    const wanted = String(value ?? '').trim().toLowerCase();
    return (options.lists[list] ?? []).find(o => o.id.toLowerCase() === wanted || o.title.toLowerCase() === wanted)?.id ?? '';
  };
  const out: Record<string, unknown> = {};
  const bought = rows.some(r => r.isPurchase === true || positive(r.unit_price) !== null);
  out.origin = bought ? 'compra' : '';
  rows.slice(0, MAX_LIVESTOCK_ROWS).forEach((row, i) => {
    // Un precio ya dicho es por cabeza; sin precio, según la categoría.
    const mode = !filled(row.category) ? '' : positive(row.unit_price) !== null ? 'head' : defaultPriceMode(row.category);
    if (i === 0) {
      out.price_mode = mode;
      return;
    }
    const prefix = `${LIVESTOCK_ROWS_GROUP}_${i}`;
    out[`${prefix}_category`] = pick('livestock_categories', row.category);
    out[`${prefix}_count`] = filled(row.count) ? String(row.count) : '';
    out[`${prefix}_breed`] = pick('breeds', row.breed);
    out[`${prefix}_unit_price`] = filled(row.unit_price) ? String(row.unit_price) : '';
    out[`${prefix}_price_mode`] = mode;
    out[`${LIVESTOCK_ROWS_GROUP}_add_${i}`] = ['si'];
  });
  return out;
}

export function livestockRowKeys(): readonly string[] {
  return ROW_KEYS;
}
