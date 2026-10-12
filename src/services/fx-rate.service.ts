/**
 * fx-rate.service.ts — dólar histórico por día (fuente ÚNICA de conversión
 * ARS ↔ USD).
 *
 * Por qué existe: la plata de una campaña quedaba en dos columnas (ARS y USD)
 * que nunca se sumaban. El productor piensa el margen en dólares, y un gasto en
 * pesos de marzo solo se compara con una venta en dólares de julio pasándolo al
 * dólar DE ESE DÍA. Convertir todo al dólar de hoy sería otro número falso.
 *
 * Fuente: https://api.argentinadatos.com/v1/cotizaciones/dolares/<casa> (sin
 * key, historia completa). Casa configurable con `FX_RATE_SOURCE` (default
 * `mayorista`, la Com. A3500 con la que se liquida el grano). Se usa el valor
 * de venta. Se guarda en `fx_rates` y se sincroniza al arrancar y una vez por
 * día; una fecha sin cotización (finde, feriado) toma la última anterior.
 *
 * La conversión se hace EN SQL (`usdEquivalentSql`) para que los reportes
 * agreguen del lado del motor. Un fallo de red nunca rompe nada: sin
 * cotización la fila queda sin equivalente y el reporte lo dice.
 */
import { pool } from '../config/db.js';
import { getSetting } from './settings.service.js';

export const FX_SOURCES = ['mayorista', 'oficial', 'bolsa', 'blue'] as const;
export type FxSource = typeof FX_SOURCES[number];

export const FX_SOURCE_LABEL: Record<FxSource, string> = {
  mayorista: 'dólar mayorista (A3500)',
  oficial: 'dólar oficial (BNA)',
  bolsa: 'dólar MEP',
  blue: 'dólar blue',
};

const API = 'https://api.argentinadatos.com/v1/cotizaciones/dolares';
const FETCH_TIMEOUT_MS = 20_000;

export async function getFxSource(): Promise<FxSource> {
  try {
    const v = String((await getSetting('FX_RATE_SOURCE')) ?? '').trim().toLowerCase();
    return (FX_SOURCES as readonly string[]).includes(v) ? (v as FxSource) : 'mayorista';
  } catch {
    return 'mayorista';
  }
}

/**
 * Expresión SQL del monto en dólares: USD tal cual; pesos divididos por el
 * dólar del día (o el último anterior). NULL si no hay cotización — nunca 0,
 * que sumaría como si el gasto no existiera.
 * `sourceParam` es el placeholder ($n) que trae la casa.
 */
export function usdEquivalentSql(amount: string, currency: string, date: string, sourceParam: string): string {
  return `(CASE WHEN ${currency} = 'USD' THEN ${amount}
           ELSE ${amount} / NULLIF((SELECT fx.sell FROM fx_rates fx
                                     WHERE fx.source = ${sourceParam} AND fx.rate_date <= ${date}::date
                                     ORDER BY fx.rate_date DESC LIMIT 1), 0) END)`;
}

/** Dólar de una fecha (o el último anterior), o null. */
export async function getRate(dateISO: string, source?: FxSource): Promise<{ date: string; sell: number } | null> {
  const src = source ?? await getFxSource();
  const { rows } = await pool.query(
    `SELECT rate_date::text AS date, sell::numeric AS sell FROM fx_rates
      WHERE source = $1 AND rate_date <= $2::date ORDER BY rate_date DESC LIMIT 1`,
    [src, dateISO],
  );
  return rows[0] ? { date: rows[0].date, sell: Number(rows[0].sell) } : null;
}

/**
 * Trae la historia completa de la casa y la guarda (upsert). La API devuelve
 * todo de una (≈4.000 filas), así que no hay paginado: un sync = una request.
 */
export async function syncFxRates(source?: FxSource, fetchImpl: typeof fetch = fetch): Promise<number> {
  const src = source ?? await getFxSource();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${API}/${src}`, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as Array<{ compra: number | null; venta: number | null; fecha: string }>;
    const rows = data.filter(d => d.venta != null && d.venta > 0 && /^\d{4}-\d{2}-\d{2}$/.test(d.fecha));
    if (rows.length === 0) return 0;
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      await pool.query(
        `INSERT INTO fx_rates (source, rate_date, buy, sell)
         SELECT $1, d::date, b, s FROM UNNEST($2::text[], $3::numeric[], $4::numeric[]) AS t(d, b, s)
         ON CONFLICT (source, rate_date) DO UPDATE SET buy = EXCLUDED.buy, sell = EXCLUDED.sell, fetched_at = NOW()`,
        [src, part.map(r => r.fecha), part.map(r => r.compra), part.map(r => r.venta)],
      );
    }
    console.log(`[FX] ${rows.length} cotizaciones de ${src} sincronizadas (última ${rows[rows.length - 1].fecha})`);
    return rows.length;
  } catch (err) {
    console.warn(`[FX] no pude sincronizar ${src}: ${(err as Error).message}`);
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/** Sincroniza solo si falta la cotización de los últimos 3 días (arranque). */
export async function ensureFxRatesFresh(): Promise<void> {
  const src = await getFxSource();
  const { rows } = await pool.query(
    `SELECT MAX(rate_date) >= CURRENT_DATE - 3 AS fresh FROM fx_rates WHERE source = $1`,
    [src],
  );
  if (!rows[0]?.fresh) await syncFxRates(src);
}
