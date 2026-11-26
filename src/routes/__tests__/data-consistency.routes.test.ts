/**
 * Auditoría de consistencia de datos (nov 2026): rutas del dashboard que dejaban
 * datos incoherentes. Corre IN-PROCESS (mismo molde que prelaunch-access) contra
 * la base local.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'data-consistency-test-secret';
let dbAvailable = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;
try {
  const mod = await import('../../config/db.js');
  pool = mod.pool;
  await pool.query('SELECT 1');
} catch (e) {
  console.log('[data-consistency test] DB no disponible:', (e as Error).message);
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('consistencia de datos en el dashboard', () => {
  let server: Server;
  let base = '';
  let userId: number;
  let token: string;
  let fieldId: number;
  let plotId: number;

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/api/auth${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });

  beforeAll(async () => {
    const { default: authRoutes } = await import('../auth.routes.js');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const email = `zz-consistency-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
    userId = (await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id) VALUES ('Consistencia', $1, 'x', 4) RETURNING id`, [email],
    )).rows[0].id;
    token = jwt.sign({ userId, role: 'user', type: 'access' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
    fieldId = (await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo C') RETURNING id`, [userId])).rows[0].id;
    await pool.query(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [fieldId, userId]);
    plotId = (await pool.query(
      `INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Lote C', 100) RETURNING id`, [fieldId],
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM harvest_loads WHERE domain_event_id IN (SELECT id FROM domain_events WHERE user_id = $1)`, [userId]);
    await pool.query(`DELETE FROM domain_events WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM plot_crops WHERE plot_id = $1`, [plotId]);
    await pool.query(`DELETE FROM plots WHERE id = $1`, [plotId]);
    await pool.query(`DELETE FROM field_members WHERE field_id = $1`, [fieldId]);
    await pool.query(`DELETE FROM fields WHERE id = $1`, [fieldId]);
    await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('#1: borrar una siembra desde el dashboard libera el lote (cultivo activo)', async () => {
    const pc = (await pool.query(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date)
       VALUES ($1, 'soja', 2026, 'gruesa', '2026-10-15') RETURNING id`, [plotId],
    )).rows[0].id;
    const ev = (await pool.query(
      `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop)
       VALUES ($1, $2, $3, 'planting', '2026-10-15', 'soja') RETURNING id`, [userId, plotId, pc],
    )).rows[0].id;

    const res = await call(`/activities/${ev}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const left = await pool.query(`SELECT 1 FROM plot_crops WHERE id = $1`, [pc]);
    expect(left.rows.length).toBe(0); // la campaña que creó la siembra se va con ella
  });

  it('#1: borrar una cosecha desde el dashboard reabre la campaña y saca sus camiones', async () => {
    const pc = (await pool.query(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, harvested_at, yield_kg, declared_yield_kg)
       VALUES ($1, 'maiz', 2026, 'gruesa', '2026-09-20', '2027-03-10', 50000, 50000) RETURNING id`, [plotId],
    )).rows[0].id;
    const ev = (await pool.query(
      `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop)
       VALUES ($1, $2, $3, 'harvest', '2027-03-10', 'maiz') RETURNING id`, [userId, plotId, pc],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO harvest_loads (domain_event_id, plot_crop_id, driver_name, weight_kg, created_by) VALUES ($1, $2, 'Pérez', 50000, $3)`,
      [ev, pc, userId],
    );

    const res = await call(`/activities/${ev}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const row = (await pool.query(`SELECT harvested_at, yield_kg, declared_yield_kg FROM plot_crops WHERE id = $1`, [pc])).rows[0];
    expect(row.harvested_at).toBeNull();
    expect(row.yield_kg).toBeNull();
    const loads = await pool.query(`SELECT 1 FROM harvest_loads WHERE domain_event_id = $1`, [ev]);
    expect(loads.rows.length).toBe(0);
  });

  it('#1: un tercero sigue sin poder borrar la actividad (404)', async () => {
    const other = (await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id) VALUES ('Otro', $1, 'x', 4) RETURNING id`,
      [`zz-consistency-otro-${Date.now()}@test.local`],
    )).rows[0].id;
    const ev = (await pool.query(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, crop) VALUES ($1, $2, 'spraying', '2026-11-01', 'soja') RETURNING id`,
      [userId, plotId],
    )).rows[0].id;
    try {
      const t = jwt.sign({ userId: other, role: 'user', type: 'access' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
      const res = await fetch(`${base}/api/auth/activities/${ev}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } });
      expect(res.status).toBe(404);
      const still = await pool.query(`SELECT deleted_at FROM domain_events WHERE id = $1`, [ev]);
      expect(still.rows[0].deleted_at).toBeNull();
    } finally {
      await pool.query(`DELETE FROM users WHERE id = $1`, [other]);
    }
  });
});
