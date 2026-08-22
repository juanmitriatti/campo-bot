/**
 * Resolución de `period` → rango de fechas para las tools de CONSULTA.
 *
 * Fuente ÚNICA. Antes había tres implementaciones separadas (financial.handler,
 * el bloque de lluvias y el de observaciones) y habían divergido:
 *
 *   - `week`:       financial usaba semana calendario (arranca lunes);
 *                   lluvias y observaciones usaban "hoy - 7" rodante.
 *   - `last_week`:  lluvias hacía "hoy - 14", que NO es la semana pasada sino
 *                   las últimas dos semanas — incluida la actual.
 *   - `last_month`: solo financial y lluvias; observaciones ni lo tenía.
 *
 * Con dos consultas del mismo período dando rangos distintos según el dominio,
 * "gastos de esta semana" y "observaciones de esta semana" no cubrían lo mismo.
 *
 * Semántica acá: CALENDARIO, no ventanas rodantes. La semana arranca lunes
 * (convención AR) y el mes es el mes calendario. Todo en hora argentina.
 */

export type QueryPeriod =
  | 'today'
  | 'week'
  | 'last_week'
  | 'month'
  | 'last_month'
  | 'year'
  | 'last_year'
  | 'all';

/** Valores aceptados. Es la lista que deben exponer los schemas de las tools. */
export const QUERY_PERIODS: readonly QueryPeriod[] = [
  'today', 'week', 'last_week', 'month', 'last_month', 'year', 'last_year', 'all',
] as const;

/** Descripción compartida para el schema de las tools (una sola redacción). */
export const QUERY_PERIOD_DESCRIPTION =
  'Período calendario. today=hoy · week=esta semana (arranca lunes) · last_week=la semana pasada completa · ' +
  'month=este mes · last_month=el mes pasado completo · year=este año · last_year=el año pasado · all=todo el historial.';

export interface PeriodRange {
  desde: string;
  hasta: string;
  /** Etiqueta para el encabezado de la respuesta ("semana pasada", "agosto 2026"). */
  label: string;
  /** true solo para `all` — los renderers lo usan para no mostrar el rango. */
  isAll: boolean;
}

/** Fecha de inicio para `all`. Anterior a cualquier dato posible del sistema. */
const EPOCH = '2000-01-01';

function isoAR(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

/** Y/M/D del calendario argentino, sin depender del TZ del proceso. */
function partsAR(now: Date): { y: number; m: number; d: number } {
  const [y, m, d] = isoAR(now).split('-').map(Number);
  return { y, m, d };
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Último día del mes (m es 1-based). Día 0 del mes siguiente. */
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Días transcurridos desde el lunes de la semana en curso.
 * getUTCDay sobre el mediodía UTC de la fecha AR evita que un corrimiento de
 * husos mueva el día de la semana.
 */
function daysSinceMonday(y: number, m: number, d: number): number {
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=domingo
  return (dow + 6) % 7; // lunes=0 … domingo=6
}

function shiftDays(y: number, m: number, d: number, delta: number): string {
  const t = Date.UTC(y, m - 1, d, 12) + delta * 24 * 60 * 60 * 1000;
  const dt = new Date(t);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function monthLabel(y: number, m: number): string {
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('es-AR', {
    month: 'long', timeZone: 'UTC',
  });
  return `${name} ${y}`;
}

/**
 * Convierte un `period` a rango de fechas.
 *
 * @param period  Valor del enum. Cualquier otra cosa devuelve null para que el
 *                caller decida su propio default (no inventamos un rango).
 * @param now     Inyectable para tests; por defecto, ahora en hora argentina.
 */
export function resolvePeriodRange(
  period: string | null | undefined,
  now: Date = new Date(),
): PeriodRange | null {
  if (!period) return null;
  const { y, m, d } = partsAR(now);
  const today = ymd(y, m, d);

  switch (period) {
    case 'today':
      return { desde: today, hasta: today, label: 'hoy', isAll: false };

    case 'week': {
      const back = daysSinceMonday(y, m, d);
      return { desde: shiftDays(y, m, d, -back), hasta: today, label: 'esta semana', isAll: false };
    }

    case 'last_week': {
      const back = daysSinceMonday(y, m, d);
      return {
        desde: shiftDays(y, m, d, -back - 7),
        hasta: shiftDays(y, m, d, -back - 1),
        label: 'semana pasada',
        isAll: false,
      };
    }

    case 'month':
      return { desde: ymd(y, m, 1), hasta: today, label: monthLabel(y, m), isAll: false };

    case 'last_month': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return {
        desde: ymd(py, pm, 1),
        hasta: ymd(py, pm, lastDayOfMonth(py, pm)),
        label: monthLabel(py, pm),
        isAll: false,
      };
    }

    case 'year':
      return { desde: ymd(y, 1, 1), hasta: today, label: `Año ${y}`, isAll: false };

    case 'last_year':
      return { desde: ymd(y - 1, 1, 1), hasta: ymd(y - 1, 12, 31), label: `Año ${y - 1}`, isAll: false };

    case 'all':
      return { desde: EPOCH, hasta: today, label: 'Todo el historial', isAll: true };

    default:
      return null;
  }
}

/**
 * Ventana rodante de N días hacia atrás, contando hoy. `days:7` → hoy y los 6
 * anteriores. Es lo que pide el param `days` de algunas tools; distinto de
 * `period:'week'`, que es la semana calendario.
 */
export function resolveDaysRange(days: number, now: Date = new Date()): PeriodRange | null {
  if (!Number.isFinite(days) || days <= 0 || days > 3650) return null;
  const { y, m, d } = partsAR(now);
  return {
    desde: shiftDays(y, m, d, -(Math.floor(days) - 1)),
    hasta: ymd(y, m, d),
    label: `últimos ${Math.floor(days)} días`,
    isAll: false,
  };
}

// ---------------------------------------------------------------------------
// Red de seguridad: período a partir del TEXTO CRUDO del usuario.
//
// El pipeline ya resuelve fechas relativas server-side para las ESCRITURAS
// (relative-dates.ts + TOOLS_WITH_DATE_PARAM: 22 tools). Para las CONSULTAS no
// había nada: "¿qué fumigué la semana pasada?" dejaba el cálculo entero en
// manos del modelo, sin red — y la doc del propio proyecto dice que Haiku corre
// los días de semana +1, que es justo por qué relative-dates SOBREESCRIBE en
// escrituras. Acá se cierra esa asimetría.
//
// Devuelve un `period` canónico cuando la frase mapea limpio (así el handler
// conserva su etiqueta y su lógica de isAll), o un rango crudo cuando no existe
// un period equivalente ("ayer", "los últimos 10 días", "en mayo").
// ---------------------------------------------------------------------------

import { hasFutureIntent } from './relative-dates.js';

export type TextPeriod =
  | { kind: 'period'; period: QueryPeriod }
  | { kind: 'range'; desde: string; hasta: string; label: string };

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

const NUM_WORDS: Record<string, number> = {
  un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, quince: 15, veinte: 20, treinta: 30,
};

function toNum(w: string): number | null {
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return NUM_WORDS[w] ?? null;
}

/**
 * @param text Texto crudo del usuario.
 * @param now  Instante real; la conversión a hora AR la hace este módulo.
 */
export function resolvePeriodFromText(
  text: string | null | undefined,
  now: Date = new Date(),
): TextPeriod | null {
  if (!text) return null;
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Períodos canónicos. "pasado/pasada/anterior" antes que el presente para que
  // "la semana pasada" no caiga en la rama de "semana".
  if (/\b(?:la\s+)?semana\s+(?:pasada|anterior)\b/.test(t)) return { kind: 'period', period: 'last_week' };
  if (/\besta\s+semana\b/.test(t)) return { kind: 'period', period: 'week' };
  if (/\b(?:el\s+)?mes\s+(?:pasado|anterior)\b/.test(t)) return { kind: 'period', period: 'last_month' };
  if (/\beste\s+mes\b/.test(t)) return { kind: 'period', period: 'month' };
  if (/\b(?:el\s+)?ano\s+(?:pasado|anterior)\b/.test(t)) return { kind: 'period', period: 'last_year' };
  if (/\beste\s+ano\b/.test(t)) return { kind: 'period', period: 'year' };
  if (/\bhoy\b/.test(t) && !hasFutureIntent(t)) return { kind: 'period', period: 'today' };

  const { y, m, d } = partsAR(now);

  // anteayer / ayer → un día puntual; no hay period equivalente.
  if (/\bantes?\s+de\s+ayer\b/.test(t) || /\banteayer\b/.test(t)) {
    const day = shiftDays(y, m, d, -2);
    return { kind: 'range', desde: day, hasta: day, label: 'anteayer' };
  }
  if (/\bayer\b/.test(t) || /\banoche\b/.test(t)) {
    const day = shiftDays(y, m, d, -1);
    return { kind: 'range', desde: day, hasta: day, label: 'ayer' };
  }

  // El finde: sábado + domingo más recientes. Si hoy es sábado, el domingo
  // todavía no pasó y el rango termina hoy.
  const mWeekend = t.match(/\b(?:el\s+)?(?:finde|fin\s+de\s+semana)(\s+pasado)?\b/);
  if (mWeekend && !hasFutureIntent(t)) {
    const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=domingo
    let backToSat = (dow - 6 + 7) % 7;
    if (backToSat === 0 && mWeekend[1]) backToSat = 7;
    const sat = shiftDays(y, m, d, -backToSat);
    const sun = backToSat >= 1 ? shiftDays(y, m, d, -(backToSat - 1)) : sat;
    return { kind: 'range', desde: sat, hasta: sun, label: 'el fin de semana' };
  }

  // "los últimos N días" / "las últimas N semanas" — ventana rodante explícita.
  const mDays = t.match(/\bultimos?\s+(\w+)\s+dias?\b/);
  if (mDays) {
    const n = toNum(mDays[1]);
    const r = n != null ? resolveDaysRange(n, now) : null;
    if (r) return { kind: 'range', desde: r.desde, hasta: r.hasta, label: r.label };
  }
  const mWeeks = t.match(/\bultimas?\s+(\w+)\s+semanas?\b/);
  if (mWeeks) {
    const n = toNum(mWeeks[1]);
    const r = n != null ? resolveDaysRange(n * 7, now) : null;
    if (r) return { kind: 'range', desde: r.desde, hasta: r.hasta, label: `últimas ${n} semanas` };
  }

  // "en mayo" / "de marzo" → ese mes. Si todavía no llegó en este año, se
  // entiende como el del año pasado ("¿cuánto gasté en diciembre?" en marzo).
  const mMonth = t.match(/\b(?:en|de|del|durante)\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/);
  if (mMonth) {
    const mm = MONTHS[mMonth[1]];
    const yy = mm > m ? y - 1 : y;
    return {
      kind: 'range',
      desde: ymd(yy, mm, 1),
      hasta: ymd(yy, mm, lastDayOfMonth(yy, mm)),
      label: monthLabel(yy, mm),
    };
  }

  return null;
}

/**
 * Tools de consulta que aceptan `period`. La red de seguridad les setea el
 * period canónico y deja que el handler haga el resto.
 */
export const QUERY_TOOLS_WITH_PERIOD: ReadonlySet<string> = new Set([
  'financial_report', 'rainfall_report', 'query_observations',
]);

/**
 * Tools de consulta que solo tienen `desde`/`hasta` (sin `period`). Acá la red
 * de seguridad escribe el rango ya resuelto.
 */
export const QUERY_TOOLS_WITH_RANGE: ReadonlySet<string> = new Set([
  'query_plot_history', 'query_scoutings', 'query_harvest_loads',
]);
