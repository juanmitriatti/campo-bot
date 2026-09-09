/**
 * Fuente ÚNICA de la merma comercial por humedad del grano.
 *
 * Cómo se liquida en la Argentina: cada cultivo tiene una humedad BASE de
 * recibo (soja 13,5 %, trigo 14 %, maíz 14,5 %…). Si el camión llega más
 * húmedo, el acopio descuenta kilos: la pérdida física de agua al secar hasta
 * la base más una "merma por manipuleo" del secado. Las tablas de la Cámara
 * Arbitral se aproximan muy bien con:
 *
 *   merma % = (H − B) / (100 − B) × 100  +  manipuleo
 *
 * (soja al 16 %: 2,89 + 0,3 ≈ 3,2 %, tabla oficial 3,2 %). Con humedad igual o
 * menor a la base no hay merma. Las bases y el manipuleo son settings del
 * admin (grupo agronomy) para que nadie tenga que redeployar si un acopio
 * liquida distinto; este archivo solo trae los defaults.
 *
 * Todo lo que convierte kilos "del camión" en kilos "comerciales" pasa por acá:
 * el handler de cosecha, la edición de una carga, la conciliación y el
 * dashboard leen `net_weight_kg`, nunca recalculan por su cuenta.
 */

export const HUMIDITY_BASE_DEFAULTS: Readonly<Record<string, number>> = {
  soja: 13.5,
  maíz: 14.5,
  maiz: 14.5,
  trigo: 14,
  girasol: 11,
  sorgo: 15,
  cebada: 12,
  avena: 13,
  centeno: 14,
  maní: 10,
  mani: 10,
  arroz: 14,
  colza: 8,
};

export const MANIPULEO_PCT_DEFAULT = 0.3;

export interface MermaConfig {
  /** Bases por cultivo (minúsculas, con o sin acento). Sobreescribe los defaults. */
  bases?: Record<string, number>;
  /** Merma por manipuleo que suma el secado, en puntos porcentuales. */
  manipuleoPct?: number;
}

function normCrop(crop: string | null | undefined): string {
  return String(crop ?? '').trim().toLowerCase();
}

/** Base de humedad para el cultivo; null si no lo conocemos (no se descuenta). */
export function getHumidityBase(crop: string | null | undefined, cfg: MermaConfig = {}): number | null {
  const key = normCrop(crop);
  if (!key) return null;
  const custom = cfg.bases?.[key] ?? cfg.bases?.[key.normalize('NFD').replace(/[̀-ͯ]/g, '')];
  if (typeof custom === 'number' && Number.isFinite(custom)) return custom;
  const def = HUMIDITY_BASE_DEFAULTS[key] ?? HUMIDITY_BASE_DEFAULTS[key.normalize('NFD').replace(/[̀-ͯ]/g, '')];
  return typeof def === 'number' ? def : null;
}

/** Merma en % (0 si no hay exceso de humedad). Redondeada a 2 decimales. */
export function computeMermaPct(humidityPct: number, basePct: number, manipuleoPct = MANIPULEO_PCT_DEFAULT): number {
  if (!Number.isFinite(humidityPct) || !Number.isFinite(basePct)) return 0;
  if (humidityPct <= basePct) return 0;
  const physical = ((humidityPct - basePct) / (100 - basePct)) * 100;
  return Math.round((physical + Math.max(0, manipuleoPct)) * 100) / 100;
}

export interface NetWeightResult {
  grossKg: number;
  netKg: number;
  mermaPct: number;
  basePct: number | null;
  /** true cuando hubo descuento (humedad > base). */
  discounted: boolean;
}

/**
 * Kilos netos comerciales de una carga. Sin humedad, o con un cultivo sin base
 * conocida, el neto es igual al bruto y merma 0: registrar nunca bloquea.
 */
export function computeNetWeight(
  grossKg: number,
  humidityPct: number | null | undefined,
  crop: string | null | undefined,
  cfg: MermaConfig = {},
): NetWeightResult {
  const gross = Number(grossKg);
  const base = getHumidityBase(crop, cfg);
  if (humidityPct == null || !Number.isFinite(Number(humidityPct)) || base == null) {
    return { grossKg: gross, netKg: gross, mermaPct: 0, basePct: base, discounted: false };
  }
  const merma = computeMermaPct(Number(humidityPct), base, cfg.manipuleoPct ?? MANIPULEO_PCT_DEFAULT);
  const net = Math.round(gross * (1 - merma / 100));
  return { grossKg: gross, netKg: net, mermaPct: merma, basePct: base, discounted: merma > 0 };
}

/**
 * Peso del camión a partir de lo que dijo el usuario. Si dio bruto y tara de
 * balanza, el peso es la diferencia; si no, el número que dijo.
 */
export function resolveDeclaredWeight(load: { weight_kg?: number | null; gross_weight_kg?: number | null; tare_kg?: number | null }): number | null {
  const gross = load.gross_weight_kg != null ? Number(load.gross_weight_kg) : null;
  const tare = load.tare_kg != null ? Number(load.tare_kg) : null;
  if (gross != null && tare != null && gross > tare) return Math.round(gross - tare);
  if (load.weight_kg != null && Number.isFinite(Number(load.weight_kg))) return Number(load.weight_kg);
  if (gross != null) return gross;
  return null;
}

/** Parsea el JSON del setting HARVEST_HUMIDITY_BASES; inválido → {} con log. */
export function parseBasesSetting(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n < 40) out[k.toLowerCase()] = n;
    }
    return out;
  } catch {
    console.warn('[MERMA] HARVEST_HUMIDITY_BASES no es JSON válido — se usan los defaults');
    return {};
  }
}

/** Config desde los settings del admin (lectura perezosa para no acoplar el util a la DB). */
export async function loadMermaConfig(): Promise<MermaConfig> {
  try {
    const { getSetting, getSettingNumber } = await import('../services/settings.service.js');
    const bases = parseBasesSetting(await getSetting('HARVEST_HUMIDITY_BASES'));
    const manipuleo = await getSettingNumber('HARVEST_MERMA_MANIPULEO_PCT');
    return { bases, manipuleoPct: manipuleo != null && Number.isFinite(manipuleo) ? manipuleo : MANIPULEO_PCT_DEFAULT };
  } catch {
    return {};
  }
}

const fmt = (n: number) => Math.round(n).toLocaleString('es-AR');

/** "31.320 kg → 30.580 neto (16% hum, merma 3,2%)" o solo "31.320 kg". */
export function describeLoadWeight(
  r: { grossKg: number; netKg: number; mermaPct: number },
  humidityPct: number | null | undefined,
): string {
  if (r.mermaPct > 0 && r.netKg !== r.grossKg) {
    const hum = humidityPct != null ? `${Number(humidityPct).toLocaleString('es-AR')}% hum, ` : '';
    return `${fmt(r.grossKg)} kg → *${fmt(r.netKg)} neto* (${hum}merma ${r.mermaPct.toLocaleString('es-AR')}%)`;
  }
  const hum = humidityPct != null ? ` (${Number(humidityPct).toLocaleString('es-AR')}% hum)` : '';
  return `${fmt(r.grossKg)} kg${hum}`;
}

/** Suma de netos de una lista de cargas ya guardadas (COALESCE(net, bruto)). */
export function sumNetKg(rows: Array<{ weight_kg: number | string; net_weight_kg?: number | string | null }>): number {
  return rows.reduce((s, r) => s + Number(r.net_weight_kg ?? r.weight_kg), 0);
}

export function sumGrossKg(rows: Array<{ weight_kg: number | string }>): number {
  return rows.reduce((s, r) => s + Number(r.weight_kg), 0);
}
