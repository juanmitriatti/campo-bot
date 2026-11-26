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

  it('#9: corregir la cantidad de una venta recalcula los kilos del saldo por acopio', async () => {
    const inc = (await pool.query(
      `INSERT INTO incomes (user_id, field_id, category, description, amount, currency, quantity, unit, quantity_kg, buyer, income_date)
       VALUES ($1, $2, 'Soja', 'venta', 9000, 'USD', 30, 'tn', 30000, 'Cargill', '2026-11-10') RETURNING id`,
      [userId, fieldId],
    )).rows[0].id;
    try {
      const res = await call(`/incomes/${inc}`, { method: 'PATCH', body: JSON.stringify({ quantity: 25 }) });
      expect(res.status).toBe(200);
      let row = (await pool.query(`SELECT quantity, quantity_kg FROM incomes WHERE id = $1`, [inc])).rows[0];
      expect(Number(row.quantity)).toBe(25);
      expect(Number(row.quantity_kg)).toBe(25000);

      // y si cambia la unidad (25 tn → 25 qq)
      await call(`/incomes/${inc}`, { method: 'PATCH', body: JSON.stringify({ unit: 'qq' }) });
      row = (await pool.query(`SELECT quantity_kg FROM incomes WHERE id = $1`, [inc])).rows[0];
      expect(Number(row.quantity_kg)).toBe(2500);
    } finally {
      await pool.query(`DELETE FROM incomes WHERE id = $1`, [inc]);
    }
  });

  it('#9: editar solo la fecha de la venta no toca los kilos', async () => {
    const inc = (await pool.query(
      `INSERT INTO incomes (user_id, field_id, category, description, amount, currency, quantity, unit, quantity_kg, income_date)
       VALUES ($1, $2, 'Soja', 'venta', 9000, 'USD', 30, 'tn', 30000, '2026-11-10') RETURNING id`,
      [userId, fieldId],
    )).rows[0].id;
    try {
      await call(`/incomes/${inc}`, { method: 'PATCH', body: JSON.stringify({ income_date: '2026-11-11' }) });
      const row = (await pool.query(`SELECT quantity_kg FROM incomes WHERE id = $1`, [inc])).rows[0];
      expect(Number(row.quantity_kg)).toBe(30000);
    } finally {
      await pool.query(`DELETE FROM incomes WHERE id = $1`, [inc]);
    }
  });

  it('#18: dejar el monto de una venta en 0 da 400 (no 500) salvo que esté "a fijar"', async () => {
    const inc = (await pool.query(
      `INSERT INTO incomes (user_id, field_id, category, description, amount, currency, income_date) VALUES ($1, $2, 'Soja', 'venta', 9000, 'USD', '2026-11-10') RETURNING id`,
      [userId, fieldId],
    )).rows[0].id;
    try {
      const res = await call(`/incomes/${inc}`, { method: 'PATCH', body: JSON.stringify({ amount: 0 }) });
      expect(res.status).toBe(400);
      expect(Number((await pool.query(`SELECT amount FROM incomes WHERE id = $1`, [inc])).rows[0].amount)).toBe(9000);
    } finally {
      await pool.query(`DELETE FROM incomes WHERE id = $1`, [inc]);
    }
  });

  it('#19: un tipo de gasto inventado se rechaza (400) y un tipo válido se acepta', async () => {
    const exp = (await pool.query(
      `INSERT INTO expenses (user_id, field_id, category, description, amount, currency, expense_date) VALUES ($1, $2, 'Otros', 'flete', 1000, 'ARS', '2026-11-10') RETURNING id`,
      [userId, fieldId],
    )).rows[0].id;
    try {
      const bad = await call(`/expenses/${exp}`, { method: 'PATCH', body: JSON.stringify({ expense_type: 'xx' }) });
      expect(bad.status).toBe(400);
      const ok = await call(`/expenses/${exp}`, { method: 'PATCH', body: JSON.stringify({ expense_type: 'insumo' }) });
      expect(ok.status).toBe(200);
    } finally {
      await pool.query(`DELETE FROM expenses WHERE id = $1`, [exp]);
    }
  });

  describe('#13 edición de un camión desde el dashboard', () => {
    let loadId: number;
    let pcId: number;
    let truckPlotId: number;
    const loadRow = async () => (await pool.query(`SELECT weight_kg, net_weight_kg, gross_weight_kg, tare_kg FROM harvest_loads WHERE id = $1`, [loadId])).rows[0];

    beforeAll(async () => {
      // Lote propio: el de los otros tests tiene una campaña reabierta (índice de una activa por lote).
      truckPlotId = (await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Lote camión', 100) RETURNING id`, [fieldId])).rows[0].id;
      pcId = (await pool.query(
        `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, harvested_at)
         VALUES ($1, 'trigo', 2098, 'fina', '2098-06-01', '2098-12-20') RETURNING id`, [truckPlotId],
      )).rows[0].id;
      const ev = (await pool.query(
        `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop) VALUES ($1, $2, $3, 'harvest', '2098-12-20', 'trigo') RETURNING id`,
        [userId, truckPlotId, pcId],
      )).rows[0].id;
      loadId = (await pool.query(
        `INSERT INTO harvest_loads (domain_event_id, plot_crop_id, driver_name, weight_kg, net_weight_kg, created_by)
         VALUES ($1, $2, 'Ruiz', 30000, 30000, $3) RETURNING id`, [ev, pcId, userId],
      )).rows[0].id;
    });
    afterAll(async () => {
      await pool.query(`DELETE FROM harvest_loads WHERE id = $1`, [loadId]);
      await pool.query(`DELETE FROM domain_events WHERE plot_crop_id = $1`, [pcId]);
      await pool.query(`DELETE FROM plot_crops WHERE id = $1`, [pcId]);
      await pool.query(`DELETE FROM plots WHERE id = $1`, [truckPlotId]);
    });

    it('un número ilegible da 400 y no cambia nada (antes se descartaba en silencio)', async () => {
      const res = await call(`/harvest-loads/${loadId}`, { method: 'PATCH', body: JSON.stringify({ weightKg: 'abc', driverName: 'Otro' }) });
      expect(res.status).toBe(400);
      expect(Number((await loadRow()).weight_kg)).toBe(30000);
    });

    it('bruto o tara negativos dan 400', async () => {
      const res = await call(`/harvest-loads/${loadId}`, { method: 'PATCH', body: JSON.stringify({ tareKg: -500 }) });
      expect(res.status).toBe(400);
      expect((await loadRow()).tare_kg).toBeNull();
    });

    it('bruto menor o igual a la tara da 400', async () => {
      const res = await call(`/harvest-loads/${loadId}`, { method: 'PATCH', body: JSON.stringify({ grossWeightKg: 10000, tareKg: 12000 }) });
      expect(res.status).toBe(400);
    });

    it('cambiar bruto y tara recalcula los kilos y el rinde de la campaña', async () => {
      const res = await call(`/harvest-loads/${loadId}`, { method: 'PATCH', body: JSON.stringify({ grossWeightKg: 32000, tareKg: 12000 }) });
      expect(res.status).toBe(200);
      const row = await loadRow();
      expect(Number(row.weight_kg)).toBe(20000); // bruto − tara; antes quedaba en 30.000
      expect(Number(row.net_weight_kg)).toBeGreaterThan(0);
      expect(Number(row.net_weight_kg)).toBeLessThanOrEqual(20000);
      const pc = (await pool.query(`SELECT yield_kg FROM plot_crops WHERE id = $1`, [pcId])).rows[0];
      expect(Number(pc.yield_kg)).toBeLessThanOrEqual(20000);
    });
  });

  describe('#10 edición de actividades en el dashboard', () => {
    const plotIds: number[] = [];
    const mkCampaign = async (crop: string, seasonType: string, seasonYear: number, start: string, harvestedAt: string | null = null) => {
      const pl = (await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, $2, 100) RETURNING id`, [fieldId, `Lote act ${plotIds.length}`])).rows[0].id as number;
      plotIds.push(pl);
      const pc = (await pool.query(
        `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, harvested_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [pl, crop, seasonYear, seasonType, start, harvestedAt],
      )).rows[0].id as number;
      return { pl, pc };
    };
    const mkEvent = async (pl: number, pc: number | null, type: string, date: string, crop: string, qty: number | null = null, unit: string | null = null) =>
      (await pool.query(
        `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop, quantity, unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [userId, pl, pc, type, date, crop, qty, unit],
      )).rows[0].id as number;
    const patch = (id: number, body: unknown) => call(`/activities/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

    afterAll(async () => {
      await pool.query(`DELETE FROM domain_events WHERE plot_id = ANY($1::int[])`, [plotIds]);
      await pool.query(`DELETE FROM plot_crops WHERE plot_id = ANY($1::int[])`, [plotIds]);
      await pool.query(`DELETE FROM plots WHERE id = ANY($1::int[])`, [plotIds]);
    });

    it('un tipo de actividad inventado se rechaza (400)', async () => {
      const { pl } = await mkCampaign('soja', 'gruesa', 2097, '2097-10-01');
      const ev = await mkEvent(pl, null, 'spraying', '2097-11-01', 'soja');
      expect((await patch(ev, { event_type: 'xx' })).status).toBe(400);
      expect((await patch(ev, { event_type: 'tillage' })).status).toBe(200);
    });

    it('una cosecha no se puede pasar a "fumigación" (conservaba camiones y rinde)', async () => {
      const { pl, pc } = await mkCampaign('soja', 'gruesa', 2096, '2096-10-01', '2097-04-01');
      const ev = await mkEvent(pl, pc, 'harvest', '2097-04-01', 'soja', 30000, 'kg');
      const res = await patch(ev, { event_type: 'spraying' });
      expect(res.status).toBe(400);
      expect((await pool.query(`SELECT event_type FROM domain_events WHERE id = $1`, [ev])).rows[0].event_type).toBe('harvest');
    });

    it('cambiar el cultivo de una siembra recalcula tipo de campaña y año (trigo → soja) y canoniza "maiz"', async () => {
      const { pl, pc } = await mkCampaign('trigo', 'fina', 2095, '2095-06-15');
      const ev = await mkEvent(pl, pc, 'planting', '2095-06-15', 'trigo');
      expect((await patch(ev, { crop: 'Soja' })).status).toBe(200);
      let c = (await pool.query(`SELECT crop, season_type, season_year FROM plot_crops WHERE id = $1`, [pc])).rows[0];
      expect(c.crop).toBe('soja');
      expect(c.season_type).toBe('gruesa'); // antes quedaba 'fina'
      expect(Number(c.season_year)).toBe(2094); // sembrada en junio: la gruesa es de la campaña anterior

      expect((await patch(ev, { crop: 'maiz' })).status).toBe(200);
      c = (await pool.query(`SELECT crop FROM plot_crops WHERE id = $1`, [pc])).rows[0];
      expect(c.crop).toBe('maíz'); // antes quedaba "maiz" sin tilde
    });

    it('el cultivo de una cosecha no se cambia (es el de su campaña)', async () => {
      const { pl, pc } = await mkCampaign('soja', 'gruesa', 2093, '2093-10-01', '2094-04-01');
      const ev = await mkEvent(pl, pc, 'harvest', '2094-04-01', 'soja', 10000, 'kg');
      expect((await patch(ev, { crop: 'trigo' })).status).toBe(400);
    });

    it('editar la cantidad de una cosecha recalcula el rinde de la campaña', async () => {
      const { pl, pc } = await mkCampaign('soja', 'gruesa', 2092, '2092-10-01', '2093-04-01');
      const ev = await mkEvent(pl, pc, 'harvest', '2093-04-01', 'soja', 30000, 'kg');
      await pool.query(`UPDATE domain_events SET harvest_yield_kg = 30000, harvest_yield_mode = 'total' WHERE id = $1`, [ev]);
      await pool.query(`UPDATE plot_crops SET yield_kg = 30000, declared_yield_kg = 30000 WHERE id = $1`, [pc]);
      expect((await patch(ev, { quantity: 25 , unit: 'tn' })).status).toBe(200);
      const c = (await pool.query(`SELECT yield_kg FROM plot_crops WHERE id = $1`, [pc])).rows[0];
      expect(Number(c.yield_kg)).toBe(25000); // antes quedaba 30.000
    });

    it('#11: la siembra no se mueve después de su cosecha ni la cosecha antes de su siembra', async () => {
      const { pl, pc } = await mkCampaign('soja', 'gruesa', 2091, '2091-10-01', '2092-04-01');
      const sow = await mkEvent(pl, pc, 'planting', '2091-10-01', 'soja');
      const harv = await mkEvent(pl, pc, 'harvest', '2092-04-01', 'soja', 10000, 'kg');
      expect((await patch(sow, { event_date: '2092-05-01' })).status).toBe(400); // después de la cosecha
      expect((await patch(harv, { event_date: '2091-09-01' })).status).toBe(400); // antes de la siembra
      expect((await patch(sow, { event_date: '2091-10-10' })).status).toBe(200); // un movimiento razonable sí
      expect((await patch(harv, { event_date: '2092-04-20' })).status).toBe(200);
    });

    it('#11: una siembra no puede caer dentro de la campaña anterior del lote', async () => {
      const first = await mkCampaign('trigo', 'fina', 2089, '2089-06-10', '2089-12-20');
      const pl = first.pl;
      // segunda campaña (soja de 2da) en el mismo lote, sembrada después de la cosecha
      await pool.query(`UPDATE plot_crops SET end_date = '2089-12-20' WHERE id = $1`, [first.pc]);
      const pc2 = (await pool.query(
        `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date) VALUES ($1, 'soja', 2089, 'gruesa', '2090-01-05') RETURNING id`, [pl],
      )).rows[0].id;
      const sow2 = await mkEvent(pl, pc2, 'planting', '2090-01-05', 'soja');
      expect((await patch(sow2, { event_date: '2089-11-01' })).status).toBe(400); // antes de que termine la cosecha del trigo
      expect((await patch(sow2, { event_date: '2090-01-20' })).status).toBe(200);
    });
  });
});
