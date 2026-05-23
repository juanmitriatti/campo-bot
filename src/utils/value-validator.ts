/**
 * Centralized validation for adversarial / out-of-range values.
 *
 * Catches the cases the parser / agent can't avoid:
 *  - Dates outside 2000-now+5 (D03 hardening)
 *  - Negative monetary amounts / quantities (Z01 hardening)
 *  - Absurd livestock counts (C03 hardening)
 *  - Absurd rainfall mm (defensive)
 *
 * Returns { ok: true } when fine, { ok: false, reason } otherwise.
 * Callers handle the reason — usually return as bot message.
 */

const MIN_YEAR = 2000;
const MAX_FUTURE_YEARS = 5;

export const LIMITS = {
  livestock_max_count: 100_000, // max animales per single add/remove
  rainfall_max_mm: 500, // max mm in a single rainfall event
  amount_max: 100_000_000_000, // max monetary amount (100B)
  hectares_max: 1_000_000, // max hectares
} as const;

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Validates a date string (YYYY-MM-DD or Date-parseable) is within 2000..now+5. */
export function validateDate(dateStr: string | null | undefined, fieldLabel = 'fecha'): ValidationResult {
  if (!dateStr) return { ok: true };
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    return { ok: false, reason: `La ${fieldLabel} "${dateStr}" no es válida. Probá con "DD de mes" o "YYYY-MM-DD".` };
  }
  const year = d.getFullYear();
  const maxYear = new Date().getFullYear() + MAX_FUTURE_YEARS;
  if (year < MIN_YEAR) {
    return { ok: false, reason: `La ${fieldLabel} ${year} es muy antigua (mínimo ${MIN_YEAR}). Revisá la fecha y volvé a intentar.` };
  }
  if (year > maxYear) {
    return { ok: false, reason: `La ${fieldLabel} ${year} es muy futura (máximo ${maxYear}). Revisá la fecha y volvé a intentar.` };
  }
  return { ok: true };
}

/** Validates a monetary amount is non-negative and within reasonable bounds. */
export function validateAmount(amount: number | null | undefined, fieldLabel = 'monto'): ValidationResult {
  if (amount == null) return { ok: true };
  if (typeof amount !== 'number' || isNaN(amount)) {
    return { ok: false, reason: `El ${fieldLabel} no es un número válido.` };
  }
  if (amount < 0) {
    return { ok: false, reason: `El ${fieldLabel} no puede ser negativo. Si querés deshacer un gasto, decime "borrar último gasto".` };
  }
  if (amount > LIMITS.amount_max) {
    return { ok: false, reason: `El ${fieldLabel} ($${amount.toLocaleString('es-AR')}) excede el máximo razonable. Revisá si los números son correctos.` };
  }
  return { ok: true };
}

/** Validates a livestock count is positive and within sanity limits. */
export function validateLivestockCount(count: number | null | undefined): ValidationResult {
  if (count == null) return { ok: true };
  if (typeof count !== 'number' || isNaN(count) || !Number.isInteger(count)) {
    return { ok: false, reason: 'La cantidad de animales debe ser un número entero.' };
  }
  if (count <= 0) {
    return { ok: false, reason: 'La cantidad de animales debe ser mayor a 0.' };
  }
  if (count > LIMITS.livestock_max_count) {
    return { ok: false, reason: `La cantidad ${count.toLocaleString('es-AR')} de animales excede el máximo razonable (${LIMITS.livestock_max_count.toLocaleString('es-AR')}). Revisá si el número es correcto.` };
  }
  return { ok: true };
}

/** Validates rainfall mm is positive and reasonable. */
export function validateRainfallMm(mm: number | null | undefined): ValidationResult {
  if (mm == null) return { ok: true };
  if (typeof mm !== 'number' || isNaN(mm)) {
    return { ok: false, reason: 'Los milímetros de lluvia deben ser un número válido.' };
  }
  if (mm <= 0) {
    return { ok: false, reason: 'Los milímetros de lluvia deben ser mayores a 0.' };
  }
  if (mm > LIMITS.rainfall_max_mm) {
    return { ok: false, reason: `${mm}mm es un valor extremadamente alto. ¿Querés decir ${Math.round(mm / 10)}mm? Lluvias > 500mm en un evento son muy raras.` };
  }
  return { ok: true };
}

/** Validates hectares is positive and within bounds. */
export function validateHectares(ha: number | null | undefined): ValidationResult {
  if (ha == null) return { ok: true };
  if (typeof ha !== 'number' || isNaN(ha) || ha <= 0) {
    return { ok: false, reason: 'Las hectáreas deben ser un número positivo.' };
  }
  if (ha > LIMITS.hectares_max) {
    return { ok: false, reason: `${ha} hectáreas excede el máximo razonable. Revisá el valor.` };
  }
  return { ok: true };
}
