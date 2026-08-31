/**
 * Helpers compartidos por los tests HTTP de rutas.
 *
 * Viven en un módulo aparte y NO en un `*.test.ts`: importar helpers desde un
 * archivo de test hace que Vitest re-ejecute sus `describe`, así que esa suite
 * corría dos veces y el segundo registro chocaba con el primero
 * (`409 Ya existe una cuenta con este email`).
 */
import { pool } from '../../config/db.js';

export const BASE = 'http://localhost:3000';

/** ¿Está levantada la app? Los tests se saltean enteros si no. */
export async function appReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

/**
 * Crea un usuario descartable y devuelve su JWT real.
 *
 * El sufijo lleva timestamp Y un aleatorio: solo con el timestamp, dos suites
 * que registran en el mismo milisegundo colisionan.
 */
export async function registerTestUser(slug: string): Promise<{ token: string; userId: number; email: string }> {
  const email = `rt-${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@routes-test.local`;
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `RT ${slug}`, email, password: 'testpass123' }),
  });
  if (!r.ok) throw new Error(`register failed: ${r.status} ${await r.text()}`);
  const body = await r.json();
  const token = body.tokens?.accessToken ?? body.token ?? body.accessToken;
  const u = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  return { token, userId: u.rows[0].id as number, email };
}

/** Cliente autenticado contra `/api/auth`. */
export function api(token: string) {
  return (path: string, opts: RequestInit = {}) =>
    fetch(`${BASE}/api/auth${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
    });
}
