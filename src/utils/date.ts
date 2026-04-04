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

/** Format a date as dd/mm/yyyy (Argentina locale) */
export function formatDateAR(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: TZ,
  });
}

/** Format a date as dd/mm (short, Argentina locale) */
export function formatDateShortAR(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: TZ,
  });
}
