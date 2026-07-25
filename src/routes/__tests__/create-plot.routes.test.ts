/**
 * POST /api/auth/fields/:id/plots — alta de lote desde el tab Campos (Jul 2026).
 * Corre contra el app REAL de Docker (localhost:3000); se saltea si no responde.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';

const BASE = 'http://localhost:3000';
let appUp = false;
let token = '';
let email = '';
let fieldId = 0;
let otherUserFieldId = 0;

async function appReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

async function register(slug: string): Promise<{ token: string; uid: number; email: string }> {
  const em = `rt-${slug}-${Date.now()}@routes-test.local`;
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `RT ${slug}`, email: em, password: 'testpass123' }),
  });
  const body = await r.json();
  const uid = (await pool.query(`SELECT id FROM users WHERE email = $1`, [em])).rows[0].id;
  return { token: body.tokens?.accessToken, uid, email: em };
}

async function cleanup(em: string): Promise<void> {
  const u = await pool.query(`SELECT id FROM users WHERE email = $1`, [em]);
  if (!u.rows.length) return;
  const uid = u.rows[0].id;
  await pool.query(`DELETE FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`, [uid]).catch(() => {});
  await pool.query(`DELETE FROM fields WHERE user_id = $1`, [uid]).catch(() => {});
  for (const t of ['refresh_tokens', 'subscriptions', 'user_settings']) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [uid]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [uid]).catch(() => {});
}

function post(path: string, body: unknown, tok = token) {
  return fetch(`${BASE}/api/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });
}

let otherEmail = '';

describe('POST /fields/:id/plots — alta de lote', () => {
  beforeAll(async () => {
    appUp = await appReachable();
    if (!appUp) return;
    const me = await register('createplot');
    token = me.token; email = me.email;
    const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'CP Campo') RETURNING id`, [me.uid]);
    fieldId = f.rows[0].id;
    await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Existente', 10)`, [fieldId]);

    const other = await register('createplot-other');
    otherEmail = other.email;
    const of = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'CP Ajeno') RETURNING id`, [other.uid]);
    otherUserFieldId = of.rows[0].id;
  });

  afterAll(async () => {
    if (appUp) { await cleanup(email); await cleanup(otherEmail); }
    await pool.end().catch(() => {});
  });

  it('crea un lote con nombre y hectáreas', async () => {
    if (!appUp) return;
    const r = await post(`/fields/${fieldId}/plots`, { name: 'Nuevo Lote', hectares: 42.5 });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.plot.name).toBe('Nuevo Lote');
    expect(Number(body.plot.hectares)).toBe(42.5);
    const db = await pool.query(`SELECT area_hectares FROM plots WHERE id = $1 AND field_id = $2`, [body.plot.id, fieldId]);
    expect(Number(db.rows[0].area_hectares)).toBe(42.5);
  });

  it('crea un lote sin hectáreas (opcional)', async () => {
    if (!appUp) return;
    const r = await post(`/fields/${fieldId}/plots`, { name: 'Sin Ha' });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.plot.hectares).toBeNull();
  });

  it('rechaza nombre duplicado en el mismo campo (409, acento-insensible)', async () => {
    if (!appUp) return;
    const r = await post(`/fields/${fieldId}/plots`, { name: 'existénte' });
    expect(r.status).toBe(409);
  });

  it('rechaza nombre vacío y hectáreas inválidas (400)', async () => {
    if (!appUp) return;
    expect((await post(`/fields/${fieldId}/plots`, { name: '  ' })).status).toBe(400);
    expect((await post(`/fields/${fieldId}/plots`, { name: 'X', hectares: -5 })).status).toBe(400);
  });

  it('rechaza crear en un campo ajeno (404)', async () => {
    if (!appUp) return;
    const r = await post(`/fields/${otherUserFieldId}/plots`, { name: 'Intruso' });
    expect(r.status).toBe(404);
  });
});
