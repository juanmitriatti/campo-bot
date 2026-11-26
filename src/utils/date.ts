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

/**
 * Fecha-calendario YYYY-MM-DD (zona AR) de un string o Date. Para pasar una
 * fecha de evento a una columna DATE sin que un `new Date(iso)` (medianoche
 * UTC) la corra un día. null si no hay fecha o no se puede leer.
 */
export function toISODateAR(date: Date | string | null | undefined): string | null {
  if (date == null || date === '') return null;
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
  const d = toDateAR(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
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

/**
 * Fecha que manda el agente → 'YYYY-MM-DD', o null si no es una fecha válida.
 *
 * Los schemas piden ISO, pero nada lo validaba en el servidor: con el formato por
 * defecto de Postgres (mes/día), un "05/11" se guardaba como 11 de MAYO. Una
 * fecha dd/mm (formato argentino) se convierte; sin año, el año en curso de AR.
 */
export function normalizeAgentDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let y: number, mo: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  const ar = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(s);
  if (iso) {
    [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (ar) {
    d = Number(ar[1]);
    mo = Number(ar[2]);
    y = ar[3] ? Number(ar[3].length === 2 ? `20${ar[3]}` : ar[3]) : Number(getTodayISO().slice(0, 4));
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
