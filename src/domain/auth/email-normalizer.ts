/**
 * Fuente ÚNICA de normalización de emails de cuenta.
 *
 * Registro, login, "olvidé mi contraseña" y edición de perfil pasaban por
 * tres criterios distintos (verbatim / lowercase / trim) y el resultado era
 * que un usuario registrado como "Juan@Gmail.com" podía loguearse solo con
 * esa capitalización exacta y NUNCA recuperar la contraseña. Todo lookup por
 * email usa además LOWER() en SQL (auth.repository) para las cuentas viejas
 * que quedaron guardadas con mayúsculas.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}
