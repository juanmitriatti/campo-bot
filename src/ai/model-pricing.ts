/**
 * model-pricing.ts — precio por millón de tokens de cada modelo que usamos.
 *
 * `saveAiUsage` / `saveAiFallbackLog` tenían el precio de Haiku 4.5
 * hardcodeado: con el análisis de datos corriendo en Sonnet u Opus, el
 * `cost_usd` que ve el admin quedaba 3-6× por debajo del real. Los callers
 * que saben qué modelo usaron calculan acá y pasan el costo.
 *
 * USD por millón: [input, output, cache read, cache write (5 min)].
 * Fuente: tabla de precios de Anthropic (Sep 2026). Un modelo desconocido
 * cae a Haiku con warning — nunca a cero.
 */

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
}

type Price = readonly [input: number, output: number, cacheRead: number, cacheWrite: number];

const HAIKU_4_5: Price = [1.0, 5.0, 0.1, 1.25];

const PRICES: Array<{ match: RegExp; price: Price }> = [
  { match: /^claude-opus-5/, price: [5.0, 25.0, 0.5, 6.25] },
  { match: /^claude-sonnet-5/, price: [2.0, 10.0, 0.2, 2.5] },
  { match: /^claude-fable-5/, price: [5.0, 25.0, 0.5, 6.25] },
  { match: /^claude-haiku-4-5/, price: HAIKU_4_5 },
];

const warned = new Set<string>();

export function priceFor(model: string | null | undefined): Price {
  const m = String(model ?? '');
  const hit = PRICES.find((p) => p.match.test(m));
  if (hit) return hit.price;
  if (!warned.has(m)) {
    warned.add(m);
    console.warn(`[model-pricing] modelo «${m || '(vacío)'}» sin precio en la tabla — uso Haiku 4.5 como aproximación`);
  }
  return HAIKU_4_5;
}

export function estimateCostUsd(model: string | null | undefined, usage: UsageLike): number {
  const [pin, pout, pread, pwrite] = priceFor(model);
  const n = (v: number | null | undefined) => (v && v > 0 ? v : 0) / 1_000_000;
  return n(usage.input_tokens) * pin
    + n(usage.output_tokens) * pout
    + n(usage.cache_read_tokens) * pread
    + n(usage.cache_write_tokens) * pwrite;
}
