/**
 * Filtro por categoría en /expenses y /incomes (Jul 2026): el dropdown del
 * dashboard manda slugs en minúscula ('combustible', 'agroquimicos') pero la
 * DB guarda las categorías canónicas ('Combustible', 'Agroquímicos') — el
 * match debe ser case/acento-insensible o el filtro devuelve siempre vacío.
 * Corre contra el app REAL de Docker (localhost:3000); se saltea si no responde.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';

const BASE = 'http://localhost:3000';
let appUp = false;
let token = '';
let email = '';
let uid = 0;

async function appReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

async function get(path: string) {
  const r = await fetch(`${BASE}/api/auth${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
}

describe('filtro por categoría — case/acento-insensible', () => {
  beforeAll(async () => {
    appUp = await appReachable();
    if (!appUp) return;
    email = `rt-catfilter-${Date.now()}@routes-test.local`;
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'RT CatFilter', email, password: 'testpass123' }),
    });
    const body = await r.json();
    token = body.tokens?.accessToken;
    uid = (await pool.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id;
    await pool.query(
      `INSERT INTO expenses (user_id, category, description, amount, currency, expense_date) VALUES
       ($1, 'Combustible', 'Gasoil test', 100000, 'ARS', CURRENT_DATE),
       ($1, 'Agroquímicos', 'Glifosato test', 200000, 'ARS', CURRENT_DATE),
       ($1, 'Semillas', 'Soja test', 300000, 'ARS', CURRENT_DATE)`,
      [uid],
    );
    await pool.query(
      `INSERT INTO incomes (user_id, category, description, amount, currency, income_date) VALUES
       ($1, 'Venta de granos', 'Soja test', 900000, 'ARS', CURRENT_DATE)`,
      [uid],
    );
  });

  afterAll(async () => {
    if (appUp && uid) {
      await pool.query(`DELETE FROM expenses WHERE user_id = $1`, [uid]).catch(() => {});
      await pool.query(`DELETE FROM incomes WHERE user_id = $1`, [uid]).catch(() => {});
      for (const t of ['refresh_tokens', 'subscriptions', 'user_settings']) {
        await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [uid]).catch(() => {});
      }
      await pool.query(`DELETE FROM users WHERE id = $1`, [uid]).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  it('gastos: el slug minúscula del dropdown matchea la categoría capitalizada', async () => {
    if (!appUp) return;
    const j = await get('/expenses?category=combustible');
    expect(j.expenses.length).toBe(1);
    expect(j.expenses[0].description).toBe('Gasoil test');
  });

  it('gastos: matchea sin tilde ("agroquimicos" → "Agroquímicos")', async () => {
    if (!appUp) return;
    const j = await get('/expenses?category=agroquimicos');
    expect(j.expenses.length).toBe(1);
    expect(j.expenses[0].description).toBe('Glifosato test');
  });

  it('gastos: una categoría que no existe devuelve vacío (no todo)', async () => {
    if (!appUp) return;
    const j = await get('/expenses?category=impuestos');
    expect(j.expenses.length).toBe(0);
  });

  it('ingresos: mismo comportamiento case-insensible', async () => {
    if (!appUp) return;
    const j = await get('/incomes?category=venta de granos');
    expect(j.incomes.length).toBe(1);
  });
});
