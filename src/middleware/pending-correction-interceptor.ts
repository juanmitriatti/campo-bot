import { extractCategoryCorrection, extractAmountCorrection, inheritAmountScale } from './conversation-engine.js';
import { detectarCategoria, detectarCategoriaIngreso } from '../utils/parser.js';
import { formatMoney } from '../utils/format-money.js';
import { detectCurrencyTerm, COPULA_ALT, CORRECTION_ALT, normLex, stripAnswerPrefix } from '../utils/lexicon.js';
import { resolveRelativeDate } from '../utils/relative-dates.js';

export interface PendingCorrectionResult {
  applied: boolean;
  /** The patched pending to store (only when applied). */
  updatedPending?: Record<string, unknown>;
  /** Confirmation card body text (only when applied). */
  body?: string;
  /** Buttons for the confirmation prompt (only when applied). */
  buttons?: Array<{ id: string; title: string }>;
  /**
   * Lote corregido, SIN resolver todavía: el caller lo resuelve contra la base
   * (plotId/fieldId). Antes solo se cambiaba el nombre y la tarjeta decía "Sur"
   * mientras se guardaba en el Norte (FIN-1, auditoría oct 2026).
   */
  correctedPlot?: string;
  /** Categoría corregida, sin validar contra el catálogo del usuario (la valida el caller). */
  correctedCategory?: string;
}

/** Monto chico sobre uno grande y redondo: "no, eran 80" sobre $50.000 — ¿80 u 80 mil? */
function isAmbiguousScale(corrected: number, previous: number | null, rawText: string, currency: string | null): boolean {
  if (!corrected || corrected >= 1000 || !previous || previous < 10_000 || previous % 1000 !== 0) return false;
  if (currency === 'USD') return false;
  // Unidad o moneda explícita: el usuario ya dijo cuál.
  return !/\b(?:mil|lucas?|palos?|millon\w*|pesos?|centavos?|ars|d[oó]lar(?:es)?|usd|u\$s|verdes?|k)\b|\$/i.test(rawText);
}

/**
 * If `pending` is an expense/income and `text` is a correction of its category,
 * amount, currency, date or lote, patch the pending and render a fresh
 * confirmation card. Returns { applied: false } otherwise. Pure except for
 * Date.now(); el lote y la categoría los valida el caller contra la base.
 *
 * Cada corrección se reconoce por lo que ES, antes de probar la siguiente: "no,
 * era en dólares" es moneda, "no, es de ayer" es fecha, "no, es del lote Sur"
 * es lote. Antes todo eso caía como CATEGORÍA ('dolares', 'de ayer') — FIN-2.
 */
export function tryApplyPendingCorrection(
  text: string,
  pending: Record<string, unknown> | undefined,
): PendingCorrectionResult {
  if (!pending || (pending.type !== 'expense' && pending.type !== 'income')) {
    return { applied: false };
  }
  const data = (pending.data ?? {}) as Record<string, unknown>;
  const t = normLex(text);
  const hasCue = new RegExp(`\\b(?:${COPULA_ALT}|${CORRECTION_ALT}|en)\\b`, 'i').test(t);

  // Moneda ("no, eran en dólares", "perdón, eran verdes"). Sinónimos en lexicon.
  const correctedCurrency: 'USD' | 'ARS' | null = hasCue ? detectCurrencyTerm(text) : null;

  // Fecha ("no, es de ayer", "fue el lunes").
  const correctedDate = hasCue && /^(?:no\b|perd[oó]n|en\s+realidad|era|es|fue)/i.test(text.trim())
    ? resolveRelativeDate(text) : null;

  // Lote ("y era en el Oeste", "no, es del lote Sur"): sin esto caía al agente
  // como edit_last_* y editaba un registro YA GUARDADO ajeno (Ago 2026).
  let correctedPlot: string | null = null;
  {
    const pm = text.match(/^(?:y\s+|no,?\s+)?(?:en\s+realidad\s+)?(?:era|es|va|iba|fue)\s+(?:en|del?)\s+(?:el\s+|la\s+)?(lote\s+)?([A-Za-zÁÉÍÓÚÑñáéíóú0-9][\wÁÉÍÓÚÑñáéíóú\s-]{0,25})\s*$/i);
    if (pm) {
      const cand = stripAnswerPrefix(pm[2]).trim();
      const isLote = !!pm[1];
      if (cand && (isLote || !correctedCurrency) && !resolveRelativeDate(cand)) correctedPlot = cand;
    }
  }

  // Categoría: solo si no es moneda, ni fecha, ni lote.
  let correctedCat: string | null = null;
  if (!correctedCurrency && !correctedDate && !correctedPlot) {
    correctedCat = extractCategoryCorrection(text);
  } else if (correctedPlot && !/\blote\b/i.test(text)) {
    // "era en sueldos": la misma forma sirve para lote y categoría. Si es una
    // palabra de categoría, gana categoría (lo decide el caller contra el catálogo).
    const cat = extractCategoryCorrection(text);
    if (cat) { correctedCat = cat; correctedPlot = null; }
  }

  let correctedAmt = extractAmountCorrection(text);
  const prevAmt = Number(data.amount) || null;
  const currency = (data.currency as string | null) ?? null;
  let ambiguous: { small: number; big: number } | null = null;
  if (correctedAmt != null) {
    if (isAmbiguousScale(correctedAmt, prevAmt, text, currency)) {
      ambiguous = { small: correctedAmt, big: correctedAmt * 1000 };
      correctedAmt = null;
    } else {
      correctedAmt = inheritAmountScale(correctedAmt, prevAmt, text, currency);
    }
  }

  if (!correctedCat && !correctedAmt && !correctedCurrency && !correctedPlot && !correctedDate && !ambiguous) return { applied: false };

  const updated: Record<string, unknown> = { ...pending, data: { ...data, timestamp: Date.now() } };
  const updatedData = updated.data as Record<string, unknown>;

  if (correctedCat) {
    const canonical =
      pending.type === 'income'
        ? (detectarCategoriaIngreso(correctedCat) || correctedCat)
        : (detectarCategoria(correctedCat) || correctedCat);
    updatedData.category = canonical;
  }
  if (correctedAmt) updatedData.amount = correctedAmt;
  if (correctedCurrency) updatedData.currency = correctedCurrency;
  if (correctedDate) {
    if (pending.type === 'expense') updatedData.expenseDate = correctedDate;
    else updatedData.incomeDate = correctedDate;
  }

  // "¿80 u 80 mil?": se pregunta con botones (decisión de producto, oct 2026).
  // El resto de lo corregido en el mismo mensaje ya queda aplicado.
  if (ambiguous) {
    console.log(`[INTERCEPT] pending-correction: monto ambiguo ${ambiguous.small} sobre ${prevAmt} — pregunto`);
    return {
      applied: true,
      updatedPending: updated,
      body: `🤔 ¿Cuánto era: *${formatMoney(ambiguous.small, 'ARS')}* o *${formatMoney(ambiguous.big, 'ARS')}*?`,
      buttons: [
        { id: `pcorr_amt_${ambiguous.small}`, title: formatMoney(ambiguous.small, 'ARS') },
        { id: `pcorr_amt_${ambiguous.big}`, title: formatMoney(ambiguous.big, 'ARS') },
      ],
    };
  }

  const { body, buttons } = renderCorrectionCard(updated);
  return {
    applied: true, updatedPending: updated, body, buttons,
    ...(correctedPlot ? { correctedPlot } : {}),
    ...(correctedCat ? { correctedCategory: updatedData.category as string } : {}),
  };
}

/** Tarjeta "¿Confirmo gasto/ingreso?" de un pendiente ya corregido. */
export function renderCorrectionCard(pending: Record<string, unknown>, note?: string): { body: string; buttons: Array<{ id: string; title: string }> } {
  const data = (pending.data ?? {}) as Record<string, unknown>;
  const verb = pending.type === 'expense' ? 'gasto' : 'ingreso';
  const emoji = pending.type === 'expense' ? '💸' : '💰';
  const plot = pending.plotName as string | null;
  const loc = plot
    ? `Lote ${plot}${pending.fieldName ? ` (${pending.fieldName})` : ''}`
    : (pending.fieldName as string) || '—';
  const date = (pending.type === 'expense' ? data.expenseDate : data.incomeDate) as string | null | undefined;
  const dateLine = date ? `\nFecha: ${String(date).slice(8, 10)}/${String(date).slice(5, 7)}` : '';
  const body = `${emoji} ¿Confirmo ${verb}?\n\nCategoría: *${data.category}*\nMonto: *${formatMoney(data.amount as number, data.currency as string)}*\nUbicación: ${loc}${dateLine}${note ? `\n\n${note}` : ''}`;
  return {
    body,
    buttons: [
      { id: 'confirm_pending', title: 'Confirmar' },
      { id: 'cancel_pending', title: 'Cancelar' },
    ],
  };
}
