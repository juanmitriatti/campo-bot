/**
 * Validación de las ediciones del dashboard (auditoría oct 2026, DSH-8/9).
 *
 * Las rutas PATCH pasaban el body directo al UPDATE: "abc" o -5 como monto,
 * 31/02 como fecha o un id inexistente daban un 500 de Postgres, y otras cosas
 * se guardaban tal cual (moneda "EUR" que después se sumaba como pesos, nombre
 * vacío, peso -300). Acá cada campo se valida y un dato inválido es un 400 con
 * un mensaje que dice qué corregir.
 *
 * Cada helper devuelve el valor ya normalizado o lanza `EditValidationError`.
 */
export class EditValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'EditValidationError';
  }
}

const MAX_MONEY = 1e12;

/** Monto: número finito, > 0 (o ≥ 0 con `allowZero`, para una venta a fijar). */
export function validMoney(v: unknown, label = 'El monto', opts: { allowZero?: boolean } = {}): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new EditValidationError(`${label} tiene que ser un número.`);
  if (opts.allowZero ? n < 0 : n <= 0) throw new EditValidationError(`${label} tiene que ser mayor a cero.`);
  if (n >= MAX_MONEY) throw new EditValidationError(`${label} es demasiado grande.`);
  return n;
}

/** Moneda: solo pesos o dólares. Cualquier otra se sumaba como pesos. */
export function validCurrency(v: unknown): 'ARS' | 'USD' {
  const c = String(v ?? '').trim().toUpperCase();
  if (c === 'ARS' || c === 'USD') return c;
  throw new EditValidationError('La moneda tiene que ser ARS o USD.');
}

/** Fecha calendario real en formato AAAA-MM-DD (31/02 no existe). */
export function validDate(v: unknown, label = 'La fecha'): string {
  const s = String(v ?? '').trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new EditValidationError(`${label} no es válida (usá AAAA-MM-DD).`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new EditValidationError(`${label} no existe.`);
  }
  if (y < 1990 || y > 2100) throw new EditValidationError(`${label} está fuera de rango.`);
  return s;
}

/** Cantidad ≥ 0, o null para borrarla. */
export function validQuantityOrNull(v: unknown, label = 'La cantidad'): number | null {
  if (v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new EditValidationError(`${label} tiene que ser un número mayor o igual a cero.`);
  if (n >= MAX_MONEY) throw new EditValidationError(`${label} es demasiado grande.`);
  return n;
}

/** Texto obligatorio, recortado, con largo máximo. */
export function validName(v: unknown, label = 'El nombre', max = 120): string {
  const s = String(v ?? '').trim();
  if (!s) throw new EditValidationError(`${label} no puede quedar vacío.`);
  if (s.length > max) throw new EditValidationError(`${label} es demasiado largo (máximo ${max} caracteres).`);
  return s;
}

/** Id positivo, o null. */
export function validIdOrNull(v: unknown, label = 'El id'): number | null {
  if (v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw new EditValidationError(`${label} no es válido.`);
  return n;
}
