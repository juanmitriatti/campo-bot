/**
 * Detect Spanish relative-date phrases in user text and resolve them to an
 * ISO date (YYYY-MM-DD, Argentina timezone).
 *
 * The agent prompt instructs Haiku to set event_date when the user mentions
 * a relative date — but the agent forgets fairly often, especially for
 * casual phrasings ("ayer pagué...", "anteayer cargué..."). This helper
 * runs server-side as a safety net so the handler gets the right date
 * regardless of what the agent did or didn't pass.
 *
 * Covers (in order of precision):
 *   - "ayer" → today - 1 day
 *   - "anteayer" / "antes de ayer" → today - 2 days
 *   - "hace N días" / "hace N dias" → today - N days
 *   - "hace N semanas" / "hace una semana" → today - N*7 days
 *   - "hace un mes" / "hace N meses" → today - N*30 days (approx)
 *   - "ayer/anteayer + a la mañana/noche" → same day as bare ayer/anteayer
 *   - "anoche" / "ayer a la noche" → today - 1 day
 *   - "esta mañana" / "esta madrugada" / "hoy temprano" → today
 *   - "la semana pasada" → today - 7 days (approx, single-date contexts)
 *   - "el mes pasado" → today - 30 days (approx, single-date contexts)
 *   - "el finde" / "el fin de semana (pasado)" → most recent past Saturday
 *
 * Returns null when no relative phrase is found, so callers can leave the
 * default date alone.
 */

import { getNowArgentina } from './date.js';

function isoDate(d: Date): string {
  // YYYY-MM-DD in Argentina timezone. Avoid Date.toISOString() which is UTC.
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function daysAgo(n: number): string {
  const now = getNowArgentina();
  const d = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  return isoDate(d);
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  veinte: 20, treinta: 30,
};

function parseNumber(word: string): number | null {
  if (!word) return null;
  const trimmed = word.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (trimmed in NUMBER_WORDS) return NUMBER_WORDS[trimmed];
  return null;
}

/**
 * Returns the ISO date (YYYY-MM-DD) corresponding to the first relative
 * phrase found in `text`, or null if none.
 *
 * Word boundaries are accent-insensitive; cases like "Ayer" / "AYER" /
 * "anteayer" / "antes de ayer" all match.
 */
export function resolveRelativeDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  // anteayer / antes de ayer
  if (/\bantes?\s+de\s+ayer\b/.test(t) || /\banteayer\b/.test(t)) {
    return daysAgo(2);
  }

  // ayer (must run after anteayer so "antes de ayer" doesn't fall into "ayer")
  if (/\bayer\b/.test(t)) {
    return daysAgo(1);
  }

  // anoche / la noche pasada → yesterday's date
  if (/\banoche\b/.test(t) || /\bla\s+noche\s+pasada\b/.test(t)) {
    return daysAgo(1);
  }

  // esta mañana / esta madrugada / hoy temprano / hoy a la mañana → today
  // ("mañana" a secas es futuro y queda fuera a propósito — no registramos fechas futuras acá)
  if (/\besta\s+(?:manana|madrugada|tarde|noche)\b/.test(t) || /\bhoy\s+(?:temprano|a\s+la\s+manana)\b/.test(t)) {
    return daysAgo(0);
  }

  // la semana pasada → ~7 días atrás (aprox; el usuario rara vez precisa el día exacto)
  if (/\bla\s+semana\s+pasada\b/.test(t)) {
    return daysAgo(7);
  }

  // el mes pasado → ~30 días atrás (aprox)
  if (/\b(?:el\s+)?mes\s+pasado\b/.test(t)) {
    return daysAgo(30);
  }

  // el finde / el fin de semana (pasado) → el sábado más reciente.
  // Suprimido con intención futura ("el finde voy a sembrar").
  const mWeekend = t.match(/\b(?:el\s+)?(?:finde|fin\s+de\s+semana)(\s+pasado)?\b/);
  if (mWeekend && !hasFutureIntent(t)) {
    const pasado = !!mWeekend[1];
    const today = getNowArgentina().getDay();
    let diff = (today - 6 + 7) % 7; // 0 = hoy es sábado
    if (diff === 0 && pasado) diff = 7;
    return daysAgo(diff);
  }

  // hace N días / hace N dias
  const mDays = t.match(/\bhace\s+(\w+)\s+d[ií]as?\b/);
  if (mDays) {
    const n = parseNumber(mDays[1]);
    if (n != null && n > 0 && n <= 365) return daysAgo(n);
  }

  // hace N semanas / hace una semana
  const mWeeks = t.match(/\bhace\s+(\w+)\s+semanas?\b/);
  if (mWeeks) {
    const n = parseNumber(mWeeks[1]);
    if (n != null && n > 0 && n <= 52) return daysAgo(n * 7);
  }

  // hace N meses / hace un mes (rough — 30 days/month)
  const mMonths = t.match(/\bhace\s+(\w+)\s+(?:mes|meses)\b/);
  if (mMonths) {
    const n = parseNumber(mMonths[1]);
    if (n != null && n > 0 && n <= 12) return daysAgo(n * 30);
  }

  // Named weekday: "el lunes", "este martes", "el viernes pasado". Resolve to the
  // most-recent PAST occurrence relative to AR-local today (the agent computed
  // these against UTC and landed them +1 day — silent corruption). "pasado" on
  // the same weekday → the previous week's.
  const mWd = t.match(/\b(?:el\s+|este\s+|del\s+)?(domingo|lunes|martes|miercoles|jueves|viernes|sabado)(\s+pasado)?\b/);
  if (mWd) {
    // "el sábado cosecho" / "el lunes voy a pagar" = plan futuro — NO retroceder
    // al sábado/lunes pasado. "pasado" explícito gana sobre el marcador futuro.
    const pasado = !!mWd[2];
    if (!pasado && hasFutureIntent(t)) return null;
    const target = WEEKDAYS[mWd[1]];
    const today = getNowArgentina().getDay();
    let diff = (today - target + 7) % 7; // 0 = today
    if (diff === 0 && pasado) diff = 7;
    return daysAgo(diff);
  }

  return null;
}

const WEEKDAYS: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};

/**
 * Marcadores de intención FUTURA. "El sábado cosecho" / "el lunes voy a pagar"
 * son planes, no registros — resolver el día de semana al PASADO los registraba
 * la semana anterior (corrupción silenciosa de fecha). Cuando el texto trae
 * uno de estos, las ramas de día-de-semana/finde NO resuelven (la fecha queda
 * en hoy, que es el default seguro). "ayer/anteayer/hace N" siguen resolviendo
 * porque son inequívocamente pasado.
 */
const FUTURE_INTENT_RE = /\b(que\s+viene|proxim[oa]s?|man[ãa]na|pasado\s+man[ãa]na|voy\s+a|vamos\s+a|va\s+a\s+(?!llover)|ire|iremos|tengo\s+que|tenemos\s+que|hay\s+que|pienso|planeo|programo|agendar|recordame|cosecho|siembro|fumigo|aplico|pago|vendo|compro|empiezo|arranco)\b/;

function hasFutureIntent(normalizedText: string): boolean {
  return FUTURE_INTENT_RE.test(normalizedText);
}

/**
 * Resolve ALL relative/weekday date phrases in a message, in left-to-right order.
 * Used for multi-day messages ("61mm el lunes, 62 el martes y 63 el sábado") so
 * each entry gets ITS OWN date instead of all collapsing onto the first (N2).
 * Overlapping phrases are masked as consumed ("anteayer" won't also yield "ayer").
 */
export function resolveAllRelativeDates(text: string | null | undefined): string[] {
  if (!text) return [];
  let t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const patterns: RegExp[] = [
    /\bantes?\s+de\s+ayer\b/,
    /\banteayer\b/,
    /\bhace\s+\w+\s+(?:dias?|semanas?|meses?)\b/,
    /\bla\s+semana\s+pasada\b/,
    /\b(?:el\s+)?mes\s+pasado\b/,
    // Finde: con intención futura solo la variante con "pasado" explícito.
    ...(hasFutureIntent(t)
      ? [/\b(?:el\s+)?(?:finde|fin\s+de\s+semana)\s+pasado\b/]
      : [/\b(?:el\s+)?(?:finde|fin\s+de\s+semana)(?:\s+pasado)?\b/]),
    /\bla\s+noche\s+pasada\b/,
    /\banoche\b/,
    /\besta\s+(?:manana|madrugada|tarde|noche)\b/,
    /\bhoy\s+(?:temprano|a\s+la\s+manana)\b/,
    /\bayer\b/,
    // Días de semana: con intención futura ("el sábado cosecho" = plan) solo
    // resuelve la variante con "pasado" explícito.
    ...(hasFutureIntent(t)
      ? [/\b(?:domingo|lunes|martes|miercoles|jueves|viernes|sabado)\s+pasado\b/]
      : [/\b(?:domingo|lunes|martes|miercoles|jueves|viernes|sabado)(?:\s+pasado)?\b/]),
  ];
  const hits: Array<{ pos: number; iso: string }> = [];
  let guard = 0;
  while (guard++ < 30) {
    let best: { index: number; str: string } | null = null;
    for (const re of patterns) {
      const m = re.exec(t);
      if (m && (best === null || m.index < best.index)) best = { index: m.index, str: m[0] };
    }
    if (!best) break;
    const iso = resolveRelativeDate(best.str);
    if (iso) hits.push({ pos: best.index, iso });
    // Mask the consumed region so it isn't re-matched (and a longer phrase doesn't
    // leave a shorter one behind).
    t = t.slice(0, best.index) + ' '.repeat(best.str.length) + t.slice(best.index + best.str.length);
  }
  return hits.sort((a, b) => a.pos - b.pos).map((h) => h.iso);
}

/**
 * Tools that accept an event_date / expense_date / income_date param. When
 * the agent omits it AND the user text has a relative phrase, the mapper
 * should inject the resolved ISO date so the handler doesn't default to
 * CURRENT_DATE.
 */
export const TOOLS_WITH_DATE_PARAM: ReadonlySet<string> = new Set([
  'log_expense', 'log_income',
  'sow_crop', 'harvest_crop',
  'log_spraying', 'log_fertilization', 'log_tillage', 'log_irrigation',
  'log_activity', 'log_tacto',
  'log_observation', 'log_crop_scouting',
  'log_rainfall', 'log_rainfall_batch',
  'add_livestock', 'remove_livestock', 'transfer_livestock',
  'log_health_event', 'log_repro_event', 'log_weighing',
  'add_stock', 'remove_stock',
]);

/** Per-tool name → which input key to fill if missing. Most use event_date. */
const DATE_KEY_BY_TOOL: Record<string, string> = {
  log_expense: 'event_date',
  log_income: 'event_date',
  // The mapper for expense/income translates event_date → data.expenseDate /
  // data.incomeDate later, so using event_date here is fine.
};

/** Get the param key for the date on this tool — defaults to event_date. */
export function dateKeyForTool(toolName: string): string {
  return DATE_KEY_BY_TOOL[toolName] ?? 'event_date';
}
