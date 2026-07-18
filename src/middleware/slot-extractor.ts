/**
 * Unified slot extractor for multi-turn parameter completion.
 *
 * When a write tool fires with required-missing slots, the handler saves a
 * PendingAction with the slots that are filled and the ones that aren't. The
 * controller intercepts the user's next message BEFORE classifying intent, runs
 * this extractor against the new text, and merges any extracted slots into the
 * pending state. When all required slots are filled, the original tool is
 * re-executed with the merged params.
 *
 * One file, one set of regexes — so a fix here propagates to every tool that
 * opts into the pending-action pattern (fertilization, spraying, expense,
 * income, sow_crop, etc.).
 */

import { normalizarMonto, detectarCategoria, detectarCategoriaIngreso } from '../utils/parser.js';
import { extractCropFromText } from '../utils/crops.ts';
import { stripPlotCorrectionPrefix } from './flows/field-step-helpers.js';
import { resolveFutureTime } from '../services/reminder.service.js';

/** Canonical slot names. Add here when a new shared slot type is introduced. */
export type SlotName =
  | 'amount'
  | 'category'
  | 'plot'
  | 'field'
  | 'crop'
  | 'quantity'
  | 'unit'
  | 'unit_price'
  | 'product'
  | 'currency'
  | 'count'
  | 'hectares'
  | 'time';

export type ExtractedSlots = Partial<Record<SlotName, unknown>>;

/**
 * Run all extractors against the given text and return whatever was found.
 * Caller decides which slots actually matter for the pending action.
 *
 * @param text Raw user message (may include conversational prefixes).
 * @param ctx Optional context for resolution (e.g. expense vs income → which
 *            category vocabulary to use).
 */
export function extractSlots(
  text: string,
  ctx: { type?: 'expense' | 'income' | 'activity' } = {},
): ExtractedSlots {
  if (!text || !text.trim()) return {};
  const out: ExtractedSlots = {};
  const stripped = stripCorrectionPrefix(text);

  const amount = extractAmount(stripped);
  if (amount != null) out.amount = amount;

  const currency = extractCurrency(stripped);
  if (currency) out.currency = currency;

  const cat = ctx.type === 'income'
    ? detectarCategoriaIngreso(stripped)
    : ctx.type === 'expense'
      ? detectarCategoria(stripped)
      : (detectarCategoriaIngreso(stripped) || detectarCategoria(stripped));
  if (cat) out.category = cat;

  const plot = extractPlotToken(stripped);
  if (plot) out.plot = plot;

  const field = extractFieldToken(stripped);
  if (field) out.field = field;

  const crop = extractCropFromText(stripped);
  if (crop) out.crop = crop;

  const qty = extractQuantityUnit(stripped);
  if (qty) {
    out.quantity = qty.quantity;
    out.unit = qty.unit;
  }

  const unitPrice = extractUnitPrice(stripped);
  if (unitPrice != null) out.unit_price = unitPrice;

  const product = extractProductName(stripped);
  if (product) out.product = product;

  const hectares = extractHectares(stripped);
  if (hectares != null) out.hectares = hectares;

  const count = extractCount(stripped);
  if (count != null) out.count = count;

  const time = extractTime(stripped);
  if (time) out.time = time;

  return out;
}

/** Strip "perdón, era / no, era / en realidad / sí" + variants */
function stripCorrectionPrefix(text: string): string {
  const m = text.trim().match(
    /^(?:perd[oó]n,?\s+|disculp[áa],?\s+|no,?\s+|en\s+realidad,?\s+|s[ií],?\s+)?(?:eran?\s+|fue(?:ron)?\s+|era\s+)?(.+)$/i,
  );
  return m ? m[1].trim() : text.trim();
}

function extractAmount(text: string): number | null {
  // Try the canonical normalizer first (handles "4.5 palos", "800 lucas", "$50000")
  const n = normalizarMonto(text);
  return n && n > 0 ? n : null;
}

function extractCurrency(text: string): 'ARS' | 'USD' | null {
  const lower = text.toLowerCase();
  if (/\b(d[oó]lares?|usd|u\$s|u\$)\b/i.test(lower)) return 'USD';
  if (/\b(pesos?|ars)\b/i.test(lower)) return 'ARS';
  return null;
}

/**
 * Extract a plot token (e.g. "A1", "B2", "lote 3", "en A1").
 *
 * Three patterns, in order:
 *   1) Conversational correction stripped by stripPlotCorrectionPrefix
 *      ("perdón, fue en B1" → "B1")
 *   2) Explicit "lote X" or "en el lote X"
 *   3) Bare "en X" where X looks like a plot id (letter+digits, ≤6 chars).
 *      This is the common pattern when the user replies just "en A1" to a
 *      "¿en qué lote?" prompt.
 */
function extractPlotToken(text: string): string | null {
  const corrected = stripPlotCorrectionPrefix(text);
  if (corrected) {
    const m = corrected.match(/^([A-Za-z]\d{1,3}|\d{1,3})\b/);
    if (m) return m[1];
  }
  // "lote X" / "en el lote X"
  let m = text.match(/\b(?:en\s+el\s+)?lote\s+([A-Za-z0-9]{1,10})\b/i);
  if (m) return m[1];
  // Bare "en X" where X is a plot-id-shaped token (letter+number or pure number).
  // Stop short to avoid catching "en La Esperanza" (field name).
  m = text.match(/\ben\s+([A-Z]\d{1,3}|\d{1,3})\b/);
  if (m) return m[1];
  return null;
}

/**
 * Extract a field name token. Conservative: only when the user explicitly says
 * "campo X" or "en X" with X being a multi-word capitalized phrase.
 */
function extractFieldToken(text: string): string | null {
  // "campo La Esperanza" / "en San Martin"
  const m = text.match(/\b(?:campo|en)\s+([A-ZÁÉÍÓÚÜÑ][\wÁÉÍÓÚÜÑáéíóúüñ\s]{2,30}?)(?:[,.]|$|\s+(?:lote|el|la|los|las))/);
  if (m) return m[1].trim();
  return null;
}

/**
 * Quantity + unit: "25 toneladas", "120 kg/ha", "50 bolsas", "10 lt".
 * Returns the first match. Unit is normalized to a canonical short form.
 */
function extractQuantityUnit(text: string): { quantity: number; unit: string } | null {
  const m = text.match(
    /(\d+(?:[.,]\d+)?)\s*(toneladas?|tn|kilos?|kg(?:\/ha)?|litros?|lts?|lt(?:\/ha)?|cc|bolsas?|qq|cabezas?|animales?|has?|hect[áa]reas?)\b/i,
  );
  if (!m) return null;
  const quantity = parseFloat(m[1].replace(',', '.'));
  const rawUnit = m[2].toLowerCase();
  const unit =
    /toneladas?|tn/.test(rawUnit) ? 'tn' :
    /kilos|kg\/ha/.test(rawUnit) ? (rawUnit.includes('ha') ? 'kg/ha' : 'kg') :
    rawUnit === 'kg' ? 'kg' :
    /litros?|lts?|^lt$|lt\/ha/.test(rawUnit) ? (rawUnit.includes('ha') ? 'lt/ha' : 'lt') :
    rawUnit === 'cc' ? 'cc' :
    /bolsas?/.test(rawUnit) ? 'bolsas' :
    rawUnit === 'qq' ? 'qq' :
    /cabezas?|animales?/.test(rawUnit) ? 'cabezas' :
    /has?|hect[áa]reas?/.test(rawUnit) ? 'ha' :
    rawUnit;
  return { quantity, unit };
}

function extractHectares(text: string): number | null {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:has?|hect[áa]reas?)\b/i);
  if (!m) return null;
  return parseFloat(m[1].replace(',', '.'));
}

function extractCount(text: string): number | null {
  // "10 cabezas", "20 animales", "30 novillos" — first integer adjacent to a
  // livestock category word.
  const m = text.match(
    /(\d+)\s*(?:cabezas?|animales?|vacas?|terneros?|terneras?|vaquillonas?|novillos?|novillitos?|toros?|toritos?|bueyes?)\b/i,
  );
  if (m) return parseInt(m[1], 10);
  // Bare count reply to "¿a cuántos animales?" — "30", "los 30", "unas 40",
  // "son 50". Anchored so it only fires on a short numeric answer, never on a
  // number buried in a longer sentence.
  const bare = text.match(/^\s*(?:a\s+)?(?:los|las|unos|unas|son|eran|fueron|todas?\s+)?\s*(\d{1,6})\s*(?:animales?|cabezas?|reses?)?\s*$/i);
  if (bare) return parseInt(bare[1], 10);
  return null;
}

/**
 * Unit price: "a 900 dólares", "a 380 mil la tn", "a 1.5 palos c/u".
 * Returns the per-unit number (with normalization via normalizarMonto so "1.5
 * palos" → 1_500_000).
 */
function extractUnitPrice(text: string): number | null {
  // Form 1: "a X (palos|mil|dólares|...)" — the canonical "a 8 mil c/u" / "a 550 USD".
  // Form 2: bare "X UNIT por TN/KG/BOLSA" / "X UNIT c/u" / "X UNIT cada una" — common
  // pending-answer phrasing where the user replies just "550 USD por tonelada"
  // without the leading "a". Without this the partial-financial queue answers
  // got an empty unit_price → silent $0 saves.
  const formAt = text.match(
    /\ba\s+([\d.,]+(?:\s*(?:mil|lucas?|palos?|millones|millon))?)\s*(?:la\s+tn|la\s+tonelada|el\s+kg|c\/u|cada\s+una?|por\s+unidad|d[oó]lares?|usd|pesos?)?/i,
  );
  if (formAt) {
    const n = normalizarMonto(formAt[1]);
    if (n && n > 0) return n;
  }
  // Form 2 — must include a "por X" / "c/u" / "cada uno" qualifier so we don't
  // misread a single dollar amount (which is the TOTAL, not per-unit).
  const formBare = text.match(
    /^([\d.,]+(?:\s*(?:mil|lucas?|palos?|millones|millon))?)\s*(?:d[oó]lares?|usd|pesos?)?\s*(?:por\s+(?:tonelada|tn|kg|kilo|bolsa|unidad|cabeza|cabezas|cada\s+\w+)|c\/u|cada\s+(?:una?|kg|tonelada|bolsa|cabeza))/i,
  );
  if (formBare) {
    const n = normalizarMonto(formBare[1]);
    if (n && n > 0) return n;
  }
  // Form 3 — número + calificador per-unit en CUALQUIER posición. Cubre la
  // respuesta conversacional típica al "¿a cuánto fue la compra?": "me
  // salieron 500000 pesos cada una", "fueron 2 millones por cabeza", "las
  // pagué 480 mil c/u". Las forms 1/2 exigían "a X" o número al inicio (^) —
  // visto live: 2 audios con el precio re-preguntados hasta que el usuario
  // mandó el número pelado (Jun 2026).
  const formAnywhere = text.match(
    /([\d.,]+(?:\s*(?:mil|lucas?|palos?|millones|millon))?)\s*(?:d[oó]lares?|usd|pesos?)?\s*(?:c\/u|cada\s+un[oa]|por\s+cabeza|por\s+animal|por\s+unidad|la\s+unidad|por\s+(?:tonelada|tn|kg|kilo|bolsa))/i,
  );
  if (formAnywhere) {
    const n = normalizarMonto(formAnywhere[1]);
    if (n && n > 0) return n;
  }
  return null;
}

/**
 * Product name: "con urea", "de glifosato". Conservative — only when there's a
 * clear preposition trigger so we don't grab random words.
 */
function extractProductName(text: string): string | null {
  const m = text.match(
    /\b(?:con|de|usando|aplicando)\s+([a-záéíóúñ][a-záéíóúñ\s\d.,-]{2,40}?)(?:[,.]|$|\s+(?:en|del|al|para|con))/i,
  );
  if (!m) return null;
  return m[1].trim();
}

/**
 * Hora para recordatorios ("a las 14:30", "a las 3 de la tarde"). Devuelve
 * SOLO horas inequívocas en HH:MM — el caso ambiguo (1-11 sin AM/PM) NO se
 * extrae acá: el handler lo detecta vía resolveFutureTime y pregunta con
 * botones. Import dinámico no: reminder.service es liviano y sin ciclos.
 */
function extractTime(text: string): string | null {
  const r = resolveFutureTime(text);
  return r && 'time' in r ? r.time : null;
}
