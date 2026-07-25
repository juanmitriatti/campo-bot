/**
 * Dataset fieldPlotCrops del endpoint /api/auth/analytics/agronomic (Jul 2026)
 * — alimenta el Treemap de lotes por campo de la vista agronómica.
 * Corre contra el app REAL de Docker (localhost:3000); se saltea si no responde.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';

const BASE = 'http://localhost:3000';
let appUp = false;
let token = '';
let email = '';
let fieldAId = 0;
let fieldBId = 0;

async function appReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

describe('analytics/agronomic — fieldPlotCrops (treemap de lotes)', () => {
  beforeAll(async () => {
    appUp = await appReachable();
    if (!appUp) return;
    email = `rt-treemap-${Date.now()}@routes-test.local`;
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'RT Treemap', email, password: 'testpass123' }),
    });
    const body = await r.json();
    token = body.tokens?.accessToken;
    const uid = (await pool.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id;

    // Campo A: 3 lotes — soja completa / maíz parcial (30 de 50 ha) / sin sembrar
    const fa = await pool.query(
      `INSERT INTO fields (user_id, name) VALUES ($1, 'Treemap Norte') RETURNING id`, [uid]);
    fieldAId = fa.rows[0].id;
    const p1 = await pool.query(
      `INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'TM Soja', 40) RETURNING id`, [fieldAId]);
    const p2 = await pool.query(
      `INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'TM Parcial', 50) RETURNING id`, [fieldAId]);
    await pool.query(
      `INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'TM Vacio', 25)`, [fieldAId]);
    await pool.query(
      `INSERT INTO plot_crops (plot_id, crop, season_year) VALUES ($1, 'Soja', 2026)`, [p1.rows[0].id]);
    await pool.query(
      `INSERT INTO plot_crops (plot_id, crop, season_year, sowed_hectares) VALUES ($1, 'Maíz', 2026, 30)`, [p2.rows[0].id]);

    // Campo B: 1 lote con trigo (para el caso multi-campo → solapas)
    const fb = await pool.query(
      `INSERT INTO fields (user_id, name) VALUES ($1, 'Treemap Sur') RETURNING id`, [uid]);
    fieldBId = fb.rows[0].id;
    const p4 = await pool.query(
      `INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'TM Trigo', 60) RETURNING id`, [fieldBId]);
    await pool.query(
      `INSERT INTO plot_crops (plot_id, crop, season_year) VALUES ($1, 'Trigo', 2026)`, [p4.rows[0].id]);
  });

  afterAll(async () => {
    if (appUp && email) {
      const u = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
      if (u.rows.length) {
        const uid = u.rows[0].id;
        await pool.query(`DELETE FROM plot_crops WHERE plot_id IN (SELECT p.id FROM plots p JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1)`, [uid]).catch(() => {});
        await pool.query(`DELETE FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`, [uid]).catch(() => {});
        await pool.query(`DELETE FROM fields WHERE user_id = $1`, [uid]).catch(() => {});
        await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [uid]).catch(() => {});
        await pool.query(`DELETE FROM subscriptions WHERE user_id = $1`, [uid]).catch(() => {});
        await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [uid]).catch(() => {});
        await pool.query(`DELETE FROM users WHERE id = $1`, [uid]).catch(() => {});
      }
    }
    await pool.end().catch(() => {});
  });

  it('field_id=all devuelve los 2 campos con lotes, hectáreas y cultivos activos', async () => {
    if (!appUp) return;
    const r = await fetch(`${BASE}/api/auth/analytics/agronomic?field_id=all`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(Array.isArray(json.fieldPlotCrops)).toBe(true);
    expect(json.fieldPlotCrops.length).toBe(2);

    const norte = json.fieldPlotCrops.find((f: any) => f.fieldName === 'Treemap Norte');
    expect(norte.plots.length).toBe(3);

    const soja = norte.plots.find((p: any) => p.plotName === 'TM Soja');
    expect(soja.hectares).toBe(40);
    expect(soja.crops).toEqual([{ crop: 'Soja', hectares: null }]);

    const parcial = norte.plots.find((p: any) => p.plotName === 'TM Parcial');
    expect(parcial.crops).toEqual([{ crop: 'Maíz', hectares: 30 }]);

    const vacio = norte.plots.find((p: any) => p.plotName === 'TM Vacio');
    expect(vacio.crops).toEqual([]);
  });

  it('field_id puntual devuelve solo ese campo', async () => {
    if (!appUp) return;
    const r = await fetch(`${BASE}/api/auth/analytics/agronomic?field_id=${fieldBId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.fieldPlotCrops.length).toBe(1);
    expect(json.fieldPlotCrops[0].fieldName).toBe('Treemap Sur');
    expect(json.fieldPlotCrops[0].plots[0].crops[0].crop).toBe('Trigo');
  });
});
