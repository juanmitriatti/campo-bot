/**
 * Auditoría oct 2026, tanda 9b: dashboard y cuenta (DSH-1/8/9/11/13/14/15/16/
 * 17/18/19, CTA-7/11/13/16). In-process contra la base local, como
 * prelaunch-access.routes.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'dashboard-account-test-secret';
let dbAvailable = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;
try {
  const mod = await import('../../config/db.js');
  pool = mod.pool;
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('dashboard y cuenta (tanda 9b)', () => {
  let server: Server;
  let base = '';
  const created: number[] = [];
  let owner: { id: number; token: string };
  let member: { id: number; token: string };
  let fieldId: number;
  let plotA: number;
  let plotB: number;

  const mkUser = async (tag: string, password = 'x') => {
    const email = `zz-9b-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
    const hash = password === 'x' ? 'x' : await bcrypt.hash(password, 4);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id) VALUES ($1, $2, $3, 4) RETURNING id`,
      [`9b ${tag}`, email, hash],
    );
    const id = rows[0].id as number;
    created.push(id);
    const token = jwt.sign({ userId: id, role: 'end_user', type: 'access' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
    return { id, token, email };
  };
  const call = (who: { token: string }, path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`${base}/api/auth${path}`, {
      ...init,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}`, ...(init.headers ?? {}) },
    });
  const expense = async (extra: Record<string, unknown> = {}) =>
    (await pool.query(
      `INSERT INTO expenses (user_id, amount, category, currency, expense_date, field_id, plot_id)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6) RETURNING id`,
      [owner.id, extra.amount ?? 1000, extra.category ?? 'Gasoil', extra.currency ?? 'ARS', extra.fieldId ?? fieldId, extra.plotId ?? null],
    )).rows[0].id as number;

  beforeAll(async () => {
    const { default: authRoutes } = await import('../auth.routes.js');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    owner = await mkUser('owner');
    member = await mkUser('member');
    const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo 9b') RETURNING id`, [owner.id]);
    fieldId = f.rows[0].id;
    await pool.query(
      `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2), ($1, $3, 'member', $2)`,
      [fieldId, owner.id, member.id],
    );
    plotA = (await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100) RETURNING id`, [fieldId])).rows[0].id;
    plotB = (await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Sur', 100) RETURNING id`, [fieldId])).rows[0].id;
  });

  afterAll(async () => {
    server?.close();
    for (const id of created) {
      for (const t of ['livestock_movements', 'livestock_groups', 'expenses', 'incomes', 'agro_observations', 'user_categories', 'channel_verifications', 'subscriptions', 'password_reset_tokens', 'harvest_loads']) {
        if (t === 'harvest_loads') continue;
        await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
      }
    }
    await pool.query(`DELETE FROM harvest_loads WHERE domain_event_id IN (SELECT id FROM domain_events WHERE user_id = $1)`, [owner.id]).catch(() => {});
    await pool.query(`DELETE FROM domain_events WHERE user_id = $1`, [owner.id]).catch(() => {});
    await pool.query(`DELETE FROM plot_crops WHERE plot_id = ANY($1::int[])`, [[plotA, plotB]]).catch(() => {});
    await pool.query(`DELETE FROM field_members WHERE field_id = $1`, [fieldId]).catch(() => {});
    await pool.query(`DELETE FROM plots WHERE field_id = $1`, [fieldId]).catch(() => {});
    await pool.query(`DELETE FROM fields WHERE id = $1`, [fieldId]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [created]).catch(() => {});
  });

  it('DSH-9/8: una edición inválida es 400 con mensaje, no 500 ni basura guardada', async () => {
    const id = await expense();
    for (const body of [{ amount: 'abc' }, { amount: -5 }, { currency: 'EUR' }, { expense_date: '2026-02-31' }, { plot_id: 99999999 }, { category: '' }]) {
      const r = await call(owner, `/expenses/${id}`, { method: 'PATCH', json: body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const row = (await pool.query(`SELECT amount::float AS amount, currency FROM expenses WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ amount: 1000, currency: 'ARS' });
  });

  it('DSH-14: el gasto acepta un lote nuevo (Asignar lote de "Para revisar")', async () => {
    const id = await expense();
    const r = await call(owner, `/expenses/${id}`, { method: 'PATCH', json: { plot_id: plotB } });
    expect(r.status).toBe(200);
    const row = (await pool.query(`SELECT plot_id, field_id FROM expenses WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ plot_id: plotB, field_id: fieldId });
  });

  it('DSH-19: corregir el gasto de una compra de hacienda corrige el precio por cabeza', async () => {
    const id = await expense({ amount: 1_000_000, category: 'Hacienda' });
    const g = await pool.query(`INSERT INTO livestock_groups (user_id, field_id, plot_id, category, count) VALUES ($1, $2, $3, 'toro', 5) RETURNING id`, [owner.id, fieldId, plotA]);
    const m = await pool.query(
      `INSERT INTO livestock_movements (user_id, movement_type, count, movement_date, source, dest_group_id, linked_expense_id, unit_price_ars)
       VALUES ($1, 'entrada', 5, CURRENT_DATE, 'manual', $2, $3, 200000) RETURNING id`,
      [owner.id, g.rows[0].id, id],
    );
    await call(owner, `/expenses/${id}`, { method: 'PATCH', json: { amount: 1_500_000 } });
    const mv = (await pool.query(`SELECT unit_price_ars::float AS p FROM livestock_movements WHERE id = $1`, [m.rows[0].id])).rows[0];
    expect(mv.p).toBe(300_000);
  });

  it('DSH-1: editar una observación guarda el texto tal cual (con mayúsculas y tildes)', async () => {
    const o = await pool.query(
      `INSERT INTO agro_observations (user_id, field_id, observation_text, normalized_text, category) VALUES ($1, $2, 'vieja', 'vieja', 'general') RETURNING id`,
      [owner.id, fieldId],
    );
    const r = await call(owner, `/observations/${o.rows[0].id}`, { method: 'PATCH', json: { observation_text: 'Chinche en el Lote Norte, daño leve', text: 'Chinche en el Lote Norte, daño leve' } });
    expect(r.status).toBe(200);
    const row = (await pool.query(`SELECT observation_text FROM agro_observations WHERE id = $1`, [o.rows[0].id])).rows[0];
    expect(row.observation_text).toBe('Chinche en el Lote Norte, daño leve');
  });

  it('DSH-17: un socio que puede editar una observación también ve su historial', async () => {
    const o = await pool.query(
      `INSERT INTO agro_observations (user_id, field_id, observation_text, normalized_text, category) VALUES ($1, $2, 'algo', 'algo', 'general') RETURNING id`,
      [owner.id, fieldId],
    );
    const r = await call(member, `/observations/${o.rows[0].id}/history`);
    expect(r.status).toBe(200);
  });

  it('DSH-11: cambiar la raza a una que ya tiene otro grupo ahí es 409; la raza se canoniza', async () => {
    const g1 = await pool.query(`INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count) VALUES ($1, $2, $3, 'vaca', 'Angus', 10) RETURNING id`, [owner.id, fieldId, plotB]);
    const g2 = await pool.query(`INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count) VALUES ($1, $2, $3, 'vaca', NULL, 5) RETURNING id`, [owner.id, fieldId, plotB]);
    const clash = await call(owner, `/livestock/${g2.rows[0].id}`, { method: 'PATCH', json: { breed: 'angus' } });
    expect(clash.status).toBe(409);
    await pool.query(`UPDATE livestock_groups SET deleted_at = NOW() WHERE id = $1`, [g1.rows[0].id]);
    const ok = await call(owner, `/livestock/${g2.rows[0].id}`, { method: 'PATCH', json: { breed: 'angus' } });
    expect(ok.status).toBe(200);
    const row = (await pool.query(`SELECT breed FROM livestock_groups WHERE id = $1`, [g2.rows[0].id])).rows[0];
    expect(row.breed).toBe('Angus');
  });

  it('DSH-13: renombrar una categoría renombra los gastos que la usaban', async () => {
    const c = await pool.query(`INSERT INTO user_categories (user_id, kind, name) VALUES ($1, 'expense', 'Repuestos varios') RETURNING id`, [owner.id]);
    const id = await expense({ category: 'Repuestos varios' });
    const r = await call(owner, `/categories/${c.rows[0].id}`, { method: 'PATCH', json: { name: 'Repuestos' } });
    expect(r.status).toBe(200);
    const row = (await pool.query(`SELECT category FROM expenses WHERE id = $1`, [id])).rows[0];
    expect(row.category).toBe('Repuestos');
  });

  it('DSH-18: bajar la superficie por debajo de lo sembrado se guarda pero avisa', async () => {
    await pool.query(`INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, sowed_hectares) VALUES ($1, 'soja', 2026, 'gruesa', CURRENT_DATE, 90)`, [plotA]);
    const r = await call(owner, `/plots/${plotA}`, { method: 'PATCH', json: { hectares: 60 } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.warning).toMatch(/90 ha sembradas/);
  });

  it('DSH-16: "Para revisar" no suma pesos y dólares en un solo número', async () => {
    await expense({ amount: 50_000, category: 'Semillas', currency: 'ARS' });
    await expense({ amount: 300, category: 'Semillas', currency: 'USD' });
    const { getReviewFindings } = await import('../../services/review-findings.service.js');
    const { campaignRange, currentSeasonYear } = await import('../../utils/campaign-range.js');
    const findings = await getReviewFindings({ userId: owner.id, fieldIds: [fieldId], range: campaignRange(currentSeasonYear()) });
    const f = findings.find((x) => x.rule === 'expense_without_plot');
    expect(f?.body).toMatch(/USD 300/);
    expect(f?.body).not.toMatch(/\$50\.300/);
  });

  it('CTA-13: cambiar el email pide la contraseña e invalida los resets pendientes', async () => {
    const u = await mkUser('email', 'clave-actual-123');
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, 'hash-9b-reset', NOW() + INTERVAL '1 hour')`,
      [u.id],
    );
    const sin = await call(u, '/me', { method: 'PATCH', json: { email: `nuevo-${u.id}@test.local` } });
    expect(sin.status).toBe(401);
    const con = await call(u, '/me', { method: 'PATCH', json: { email: `nuevo-${u.id}@test.local`, current_password: 'clave-actual-123' } });
    expect(con.status).toBe(200);
    const t = (await pool.query(`SELECT used_at FROM password_reset_tokens WHERE user_id = $1`, [u.id])).rows[0];
    expect(t.used_at).not.toBeNull();
  });

  it('CTA-16: el token de una cuenta suspendida deja de servir en el momento', async () => {
    const u = await mkUser('susp');
    expect((await call(u, '/me')).status).toBe(200);
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [u.id]);
    const { invalidateAccountState } = await import('../../middleware/auth.middleware.js');
    invalidateAccountState(u.id);
    expect((await call(u, '/me')).status).toBe(403);
  });

  describe('vincular WhatsApp', () => {
    const seedCode = async (userId: number, phone: string) => {
      await pool.query(
        `INSERT INTO channel_verifications (user_id, channel, code, target, expires_at) VALUES ($1, 'whatsapp', '123456', $2, NOW() + INTERVAL '10 minutes')`,
        [userId, phone],
      );
    };
    const confirm = (u: { token: string }) => call(u, '/verify/whatsapp/confirm', { method: 'POST', json: { code: '123456' } });

    it('CTA-7: el número de una cuenta de chat vacía se libera y se vincula', async () => {
      const u = await mkUser('wa1');
      const phone = `54911${String(Date.now()).slice(-8)}`;
      const chat = await pool.query(`INSERT INTO users (phone_number) VALUES ($1) RETURNING id`, [phone]);
      created.push(chat.rows[0].id);
      await seedCode(u.id, phone);
      const r = await confirm(u);
      expect(r.status).toBe(200);
      expect((await pool.query(`SELECT phone_number FROM users WHERE id = $1`, [u.id])).rows[0].phone_number).toBe(phone);
    });

    it('CTA-7: si la cuenta de chat tiene datos, 409 con explicación y el código sigue sirviendo', async () => {
      const u = await mkUser('wa2');
      const phone = `54912${String(Date.now()).slice(-8)}`;
      const chat = await pool.query(`INSERT INTO users (phone_number) VALUES ($1) RETURNING id`, [phone]);
      created.push(chat.rows[0].id);
      await pool.query(`INSERT INTO expenses (user_id, amount, category, expense_date) VALUES ($1, 10, 'Otros', CURRENT_DATE)`, [chat.rows[0].id]);
      await seedCode(u.id, phone);
      const r = await confirm(u);
      expect(r.status).toBe(409);
      const pending = await pool.query(`SELECT verified_at FROM channel_verifications WHERE user_id = $1`, [u.id]);
      expect(pending.rows[0].verified_at).toBeNull();
    });

    it('CTA-11: un número que ya usó una prueba en otra cuenta no da una prueba nueva', async () => {
      const old = await mkUser('wa-old');
      const phone = `54913${String(Date.now()).slice(-8)}`;
      await pool.query(`INSERT INTO channel_verifications (user_id, channel, code, target, expires_at, verified_at) VALUES ($1, 'whatsapp', '000000', $2, NOW(), NOW())`, [old.id, phone]);
      await pool.query(`INSERT INTO subscriptions (user_id, plan_id, provider, status, trial_ends_at) VALUES ($1, 4, 'trial', 'expired', NOW() - INTERVAL '1 day')`, [old.id]);
      const fresh = await mkUser('wa-new');
      await pool.query(`INSERT INTO subscriptions (user_id, plan_id, provider, status, trial_ends_at) VALUES ($1, 4, 'trial', 'trial', NOW() + INTERVAL '14 days')`, [fresh.id]);
      await seedCode(fresh.id, phone);
      expect((await confirm(fresh)).status).toBe(200);
      const sub = (await pool.query(`SELECT status FROM subscriptions WHERE user_id = $1`, [fresh.id])).rows[0];
      expect(sub.status).toBe('expired');
    });
  });
});
