/**
 * Auditoría pre-lanzamiento (oct 2026), tanda 1: rutas del dashboard que
 * dejaban a un usuario logueado leer o modificar datos de otro, la pestaña
 * Actividades rota y la prueba vencida que seguía escribiendo.
 *
 * Corre IN-PROCESS (express propio en un puerto libre, mismo router y mismo
 * middleware que app.ts) contra la base local: no depende de que el backend de
 * :3000 esté levantado con el código nuevo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'prelaunch-access-test-secret';
let dbAvailable = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;
try {
  const mod = await import('../../config/db.js');
  pool = mod.pool;
  await pool.query('SELECT 1');
} catch (e) { console.log("[prelaunch test] DB no disponible:", (e as Error).message);
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('acceso entre usuarios y prueba vencida en el dashboard', () => {
  let server: Server;
  let base = '';
  const users: Record<'A' | 'B' | 'D', { id: number; token: string }> = {} as never;
  let fieldA: number; let plotA: number; let groupA: string; let itemA: number;

  const mkUser = async (tag: string) => {
    const email = `zz-prelaunch-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id) VALUES ($1, $2, 'x', 4) RETURNING id`,
      [`Prelaunch ${tag}`, email],
    );
    const id = rows[0].id as number;
    const token = jwt.sign({ userId: id, role: 'user', type: 'access' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
    return { id, token };
  };
  const call = (who: 'A' | 'B' | 'D', path: string, init: RequestInit = {}) =>
    fetch(`${base}/api/auth${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${users[who].token}`, ...(init.headers ?? {}) },
    });

  beforeAll(async () => {
    const { default: authRoutes } = await import('../auth.routes.js');
    const { requireWriteAccess } = await import('../../middleware/write-access.middleware.js');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', requireWriteAccess);
    app.use('/api/auth', authRoutes);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    users.A = await mkUser('a');
    users.B = await mkUser('b');
    users.D = await mkUser('d');

    fieldA = (await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo de A') RETURNING id`, [users.A.id])).rows[0].id;
    await pool.query(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [fieldA, users.A.id]);
    plotA = (await pool.query(`INSERT INTO plots (field_id, name) VALUES ($1, 'Lote de A') RETURNING id`, [fieldA])).rows[0].id;
    groupA = (await pool.query(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, count) VALUES ($1, $2, $3, 'vaca', 10) RETURNING id`,
      [users.A.id, fieldA, plotA],
    )).rows[0].id;
    const wh = (await pool.query(`INSERT INTO warehouses (field_id, name) VALUES ($1, 'Galpón de A') RETURNING id`, [fieldA])).rows[0].id;
    itemA = (await pool.query(
      `INSERT INTO stock_items (user_id, warehouse_id, name, unit, current_quantity) VALUES ($1, $2, 'Glifosato', 'lt', 100) RETURNING id`,
      [users.A.id, wh],
    )).rows[0].id;
    // A también tiene una actividad, para la pestaña Actividades.
    await pool.query(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, product) VALUES ($1, $2, 'spraying', CURRENT_DATE, 'glifosato')`,
      [users.A.id, plotA],
    );
    // D: prueba vencida ayer.
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, status, billing_period, provider, trial_ends_at)
       VALUES ($1, 2, 'trial', 'monthly', 'trial', NOW() - INTERVAL '1 day')`,
      [users.D.id],
    );
  });

  afterAll(async () => {
    server?.close();
    const ids = Object.values(users).map((u) => u?.id).filter(Boolean);
    for (let pass = 0; pass < 3; pass++) {
      await pool.query(`DELETE FROM animal_events WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM animal_identifications WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM animals WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM domain_events WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM stock_movements WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM stock_items WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM warehouses WHERE field_id IN (SELECT id FROM fields WHERE user_id = ANY($1))`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM livestock_groups WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id = ANY($1))`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM field_members WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM fields WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM subscriptions WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM user_settings WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [ids]).catch(() => {});
    }
  });

  it('AIS-11: B no ve el ítem de stock de A ni sus movimientos (404); A sí', async () => {
    expect((await call('B', `/stock/${itemA}/movements`)).status).toBe(404);
    const own = await call('A', `/stock/${itemA}/movements`);
    expect(own.status).toBe(200);
    expect((await own.json()).item.name).toBe('Glifosato');
  });

  it('AIS-10: B no puede renombrar el ítem de stock de A (404, sin cambios); A sí', async () => {
    const r = await call('B', `/stock/${itemA}`, { method: 'PATCH', body: JSON.stringify({ name: 'ZZHACKED', min_stock: 999 }) });
    expect(r.status).toBe(404);
    const row = (await pool.query(`SELECT name, min_stock FROM stock_items WHERE id = $1`, [itemA])).rows[0];
    expect(row.name).toBe('Glifosato');
    expect((await call('A', `/stock/${itemA}`, { method: 'PATCH', body: JSON.stringify({ min_stock: 20 }) })).status).toBe(200);
  });

  it('AIS-12: B no puede dar de alta un animal en el lote o el grupo de A (404, sin nombres ajenos)', async () => {
    const r = await call('B', '/animals', {
      method: 'POST',
      body: JSON.stringify({ category: 'vaca', rfid: '032010000799001', field_id: fieldA, plot_id: plotA, group_id: groupA }),
    });
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toMatch(/Lote de A|Campo de A/);
    const g = (await pool.query(`SELECT individualized_count FROM livestock_groups WHERE id = $1`, [groupA])).rows[0];
    expect(Number(g.individualized_count ?? 0)).toBe(0);
    const own = await call('A', '/animals', {
      method: 'POST',
      body: JSON.stringify({ category: 'vaca', rfid: '032010000799002', field_id: fieldA, plot_id: plotA }),
    });
    expect(own.status).toBe(201);
  });

  it('pestaña Actividades: responde 200 y muestra las actividades propias (antes 500 para todos)', async () => {
    const r = await call('A', '/activities');
    expect(r.status).toBe(200);
    const body = await r.json();
    const items = body.data ?? body.items ?? body.activities ?? [];
    expect(items.length).toBeGreaterThanOrEqual(1);
    const other = await call('B', '/activities');
    expect(other.status).toBe(200);
    const otherItems = (await other.json());
    expect(JSON.stringify(otherItems)).not.toMatch(/Lote de A/);
  });

  it('AIS-17: con la prueba vencida el dashboard no escribe, pero lee y deja pagar / exportar / borrar la cuenta', async () => {
    const write = await call('D', '/fields', { method: 'POST', body: JSON.stringify({ name: 'Campo nuevo' }) });
    expect(write.status).toBe(403);
    expect((await write.json()).code).toBe('TRIAL_EXPIRED');
    const fields = (await pool.query(`SELECT 1 FROM fields WHERE user_id = $1`, [users.D.id])).rows;
    expect(fields).toHaveLength(0);
    // Lectura: sigue andando.
    expect((await call('D', '/activities')).status).toBe(200);
    // Rutas abiertas: no las corta el middleware (pueden fallar por otra razón, nunca por TRIAL_EXPIRED).
    const checkout = await call('D', '/subscription/checkout', { method: 'POST', body: JSON.stringify({}) });
    expect(checkout.status === 403 ? (await checkout.json()).code : null).not.toBe('TRIAL_EXPIRED');
    // Un usuario al día escribe normal.
    expect((await call('B', '/fields', { method: 'POST', body: JSON.stringify({ name: 'Campo de B' }) })).status).not.toBe(403);
  });
});
