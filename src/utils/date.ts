/**
 * Centralized Argentina timezone date utilities.
 * All dates in this project must use America/Argentina/Buenos_Aires (UTC-3).
 */

const TZ = 'America/Argentina/Buenos_Aires';

/** Get current Date object adjusted to Argentina timezone */
export function getNowArgentina(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

/** Get today's date in YYYY-MM-DD format (Argentina timezone) */
export function getTodayISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

/**
 * A date-only string (YYYY-MM-DD) is a CALENDAR date, not an instant.
 * `new Date('2026-06-06')` parses as UTC midnight, which in AR (UTC-3) renders as
 * the PREVIOUS day (off-by-one). Anchor at noon UTC so the conversion never
 * crosses midnight. Full timestamps / Date objects are left untouched.
 */
function toDateAR(date: Date | string): Date {
  if (typeof date === 'string') {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00Z`) : new Date(date);
  }
  // node-postgres devuelve las columnas DATE como Date a MEDIANOCHE (UTC,
  // porque el proceso corre en UTC). Formatear eso en ART (UTC-3) lo corre al
  // día ANTERIOR — off-by-one visto live: vacunación guardada el 12/06 se
  // mostraba "11/06". Una fecha-calendario no es un instante: la anclamos a
  // mediodía para que ninguna conversión de zona cruce la medianoche. (Un
  // timestamp real que caiga exactamente en 00:00:00.000 es despreciable.)
  if (date instanceof Date
      && date.getUTCHours() === 0 && date.getUTCMinutes() === 0
      && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0) {
    return new Date(date.getTime() + 12 * 3600 * 1000);
  }
  return date;
}

/** Format a date as dd/mm/yyyy (Argentina locale) */
export function formatDateAR(date: Date | string): string {
  return toDateAR(date).toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: TZ,
  });
}

/** Format dd/mm/yy (Argentina) — para listados compactos. Usa toDateAR: una
 * columna DATE (medianoche UTC) renderizada a pelo en ART retrocedía un día
 * (gasto del 01/08 mostrado "31/07" — QA agentes Ago 2026). */
export function formatDayShortAR(date: Date | string): string {
  return toDateAR(date).toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: '2-digit', timeZone: TZ,
  });
}

/** Format a date as dd/mm (short, Argentina locale) */
export function formatDateShortAR(date: Date | string): string {
  return toDateAR(date).toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: TZ,
  });
}
