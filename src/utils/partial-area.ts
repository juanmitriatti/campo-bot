/**
 * Partial-area parsing for sowing/edits.
 *
 * Argentine farmers describe partial-plot sowing in fractions of the lote rather
 * than absolute hectares ("sembré la mitad del lote", "un tercio", "el 30% del
 * lote"). The agent only fills `hectares` when an explicit number is present, so
 * these phrasings used to be silently dropped — the campaign kept showing the
 * FULL plot area. These helpers convert that language to hectares deterministically
 * so it works whether or not the LLM extracted it, in BOTH sow_crop and
 * edit_last_activity.
 */

function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Round to 2 decimals, dropping a trailing .0 — keeps "17.5", turns "20.00" into 20. */
function tidy(n: number): number {
  return Math.round(n * 100) / 100;
}

const FRACTION_PATTERNS: Array<{ re: RegExp; factor: number }> = [
  // halves
  { re: /\b(la\s+)?mitad\b/, factor: 1 / 2 },
  { re: /\bmedio\s+lote\b/, factor: 1 / 2 },
  // thirds
  { re: /\bdos\s+tercios?\b/, factor: 2 / 3 },
  { re: /\b(un\s+)?tercio\b/, factor: 1 / 3 },
  { re: /\b(la\s+)?tercera\s+parte\b/, factor: 1 / 3 },
  // quarters
  { re: /\btres\s+cuartos?\b/, factor: 3 / 4 },
  { re: /\b(un\s+)?cuarto\b/, factor: 1 / 4 },
  { re: /\b(la\s+)?cuarta\s+parte\b/, factor: 1 / 4 },
];

/**
 * Resolve a fraction/percentage of a plot's area to hectares.
 *
 * Returns null when the text has no partial-area cue, when the plot area is
 * unknown, or when the computed value isn't a sensible positive number.
 * "two thirds" / "el 30%" / "la mitad del lote" → fraction × plotAreaHa.
 */
export function resolvePartialArea(text: string, plotAreaHa: number | null | undefined): number | null {
  if (plotAreaHa == null || !(plotAreaHa > 0)) return null;
  const t = normalize(text);

  // Percentage: "el 30%", "30 por ciento", "un 25 %"
  const pct = t.match(/\b(\d{1,3}(?:[.,]\d+)?)\s*(?:%|por\s*ciento)/);
  if (pct) {
    const p = parseFloat(pct[1].replace(',', '.'));
    if (p > 0 && p <= 100) {
      const ha = tidy((p / 100) * plotAreaHa);
      return ha > 0 ? ha : null;
    }
  }

  for (const { re, factor } of FRACTION_PATTERNS) {
    if (re.test(t)) {
      const ha = tidy(factor * plotAreaHa);
      return ha > 0 ? ha : null;
    }
  }
  return null;
}

/**
 * Cheap presence check: does the text mention a fraction/percentage of the plot?
 * Used to let a fraction-only correction ("sembré la mitad del lote") pass an
 * edit's change-guard before the plot area (needed to compute the value) is known.
 */
export function hasPartialAreaCue(text: string): boolean {
  const t = normalize(text);
  if (/\b\d{1,3}(?:[.,]\d+)?\s*(?:%|por\s*ciento)/.test(t)) return true;
  return FRACTION_PATTERNS.some(({ re }) => re.test(t));
}

/**
 * Extract an explicit sown-area in hectares from free text.
 *
 * Matches "20 ha", "20 hs", "17,5 hectáreas". Deliberately requires an explicit
 * hectare unit so it never grabs an unrelated number (price, count, mm). Used as
 * a deterministic backstop when correcting a siembra ("sembré solo 20 ha, no 35")
 * in case the agent forgets to pass new_hectares.
 */
export function extractExplicitHectares(text: string): number | null {
  const t = normalize(text);
  const m = t.match(/\b(\d+(?:[.,]\d+)?)\s*(?:has?|hs|hect(?:a|á)reas?)\b/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return n > 0 ? tidy(n) : null;
}
