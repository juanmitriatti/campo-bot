/**
 * Precio anual configurable por plan (/admin → Planes, Jul 2026).
 * Corre contra el app REAL de Docker (localhost:3000). Registra un usuario
 * descartable, lo promueve a admin por DB y usa el admin API. Se saltea
 * entero si el app no responde (CI sin docker).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';

const BASE = 'http://localhost:3000';
let appUp = false;
let token = '';
let email = '';
let planId = 0;
let originalYearly: number | null = null;

async function appReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

async function registerAdmin(): Promise<void> {
  email = `rt-plans-yearly-${Date.now()}@routes-test.local`;
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RT PlansYearly', email, password: 'testpass123' }),
  });
  if (!r.ok) throw new Error(`register failed: ${r.status}`);
  await pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  // Login de nuevo para que el JWT lleve el rol admin
  const l = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpass123' }),
  });
  const body = await l.json();
  token = body.tokens?.accessToken ?? body.token ?? body.accessToken;
}

function adminApi(path: string, opts: RequestInit = {}) {
  return fetch(`${BASE}/admin/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
}

describe('admin plans — precio anual configurable', () => {
  beforeAll(async () => {
    appUp = await appReachable();
    if (!appUp) return;
    await registerAdmin();
    const p = await pool.query(`SELECT id, price_ars_yearly FROM plans WHERE name = 'pro_plus'`);
    planId = p.rows[0].id;
    originalYearly = p.rows[0].price_ars_yearly;
  });

  afterAll(async () => {
    if (!appUp) return;
    // Restaurar el precio anual original y borrar el usuario de prueba
    await pool.query(`UPDATE plans SET price_ars_yearly = $1 WHERE id = $2`, [originalYearly, planId]).catch(() => {});
    await pool.query(`DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, [email]).catch(() => {});
    await pool.query(`DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, [email]).catch(() => {});
    await pool.query(`DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, [email]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE email = $1`, [email]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('GET /admin/api/plans expone priceArsYearly', async () => {
    if (!appUp) return;
    const r = await adminApi('/plans');
    expect(r.status).toBe(200);
    const plans = await r.json();
    const proPlus = plans.find((p: any) => p.name === 'pro_plus');
    expect(proPlus).toBeDefined();
    expect('priceArsYearly' in proPlus).toBe(true);
  });

  it('PUT /admin/api/plans/:id persiste priceArsYearly', async () => {
    if (!appUp) return;
    const r = await adminApi(`/plans/${planId}`, {
      method: 'PUT',
      body: JSON.stringify({ priceArsYearly: 100000 }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.priceArsYearly).toBe(100000);
    const db = await pool.query(`SELECT price_ars_yearly FROM plans WHERE id = $1`, [planId]);
    expect(Number(db.rows[0].price_ars_yearly)).toBe(100000);
  });

  it('PUT /admin/api/plans/:id acepta null para desactivar el precio anual', async () => {
    if (!appUp) return;
    const r = await adminApi(`/plans/${planId}`, {
      method: 'PUT',
      body: JSON.stringify({ priceArsYearly: null }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.priceArsYearly).toBeNull();
    const db = await pool.query(`SELECT price_ars_yearly FROM plans WHERE id = $1`, [planId]);
    expect(db.rows[0].price_ars_yearly).toBeNull();
  });
});
