/**
 * Tests HTTP de los endpoints del paquete dashboard pre-lanzamiento.
 * Corren contra el app REAL de Docker (localhost:3000) con registro de
 * usuario descartable → JWT real. Asserts de DB vía pool directo (:5433).
 * Se saltean enteros si el app no responde (CI sin docker).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';

const BASE = 'http://localhost:3000';
let appUp = false;

async function appReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

export async function registerTestUser(slug: string): Promise<{ token: string; userId: number; email: string }> {
  const email = `rt-${slug}-${Date.now()}@routes-test.local`;
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `RT ${slug}`, email, password: 'testpass123' }),
  });
  if (!r.ok) throw new Error(`register failed: ${r.status} ${await r.text()}`);
  const body = await r.json();
  // register returns { user, tokens: { accessToken, refreshToken } }
  const token = body.tokens?.accessToken ?? body.token ?? body.accessToken;
  const u = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  return { token, userId: u.rows[0].id as number, email };
}

export function api(token: string) {
  return (path: string, opts: RequestInit = {}) =>
    fetch(`${BASE}/api/auth${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
    });
}

async function cleanupUser(email: string): Promise<void> {
  const u = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (u.rows.length === 0) return;
  const uid = u.rows[0].id;
  for (let pass = 0; pass < 3; pass++) {
    await pool.query(`DELETE FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`, [uid]).catch(() => {});
    const tablesR = await pool.query(
      `SELECT DISTINCT table_name FROM information_schema.columns
       WHERE column_name = 'user_id' AND table_schema = 'public' AND table_name <> 'users'`,
    );
    for (const t of tablesR.rows) await pool.query(`DELETE FROM "${t.table_name}" WHERE user_id = $1`, [uid]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [uid]).catch(() => {});
}

describe('dashboard prelaunch — seguridad (Task 1)', () => {
  beforeAll(async () => { appUp = await appReachable(); });

  it('POST /api/test-bot en no-prod sigue abierto para usuarios comunes', async () => {
    if (!appUp) return; // skip sin docker
    const { token, email } = await registerTestUser('chat-noprod');
    try {
      const r = await fetch(`${BASE}/api/test-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: 'hola' }),
      });
      // Docker local NO es prod (sin RAILWAY_*) → el gate deja pasar
      expect(r.status).toBe(200);
    } finally { await cleanupUser(email); }
  });

  it('GET /samples/* ya no existe', async () => {
    if (!appUp) return;
    const r = await fetch(`${BASE}/samples/whatever.pdf`);
    expect(r.status).toBe(404);
  });
});
