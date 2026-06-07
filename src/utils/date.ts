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

/** Format a date as dd/mm (short, Argentina locale) */
export function formatDateShortAR(date: Date | string): string {
  return toDateAR(date).toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: TZ,
  });
}
