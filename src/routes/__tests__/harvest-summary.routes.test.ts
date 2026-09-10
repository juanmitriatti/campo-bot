/**
 * GET /api/auth/harvest-summary — paridad chat ↔ dashboard de la cosecha
 * comercial (Sep 2026). Lo que el bot guarda con la migración 120 y la web no
 * mostraba: rinde esperado, avance en ha, fechas de inicio/fin, saldo por
 * acopio y retiros. Pega al backend real de :3000 (se saltea si no está).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { appReachable, registerTestUser, api } from './routes-helpers.js';

let appUp = false;
beforeAll(async () => { appUp = await appReachable(); });

interface Summary {
  campaign: { seasonYear: number; label: string; from: string; to: string };
  campaigns: Array<Record<string, unknown>>;
  grainBalance: Array<Record<string, unknown>>;
  withdrawals: Array<Record<string, unknown>>;
}

async function seedUser(slug: string) {
  const u = await registerTestUser(slug);
  const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Esperanza') RETURNING id`, [u.userId]);
  const fieldId = f.rows[0].id as number;
  const p = await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100) RETURNING id`, [fieldId]);
  const norteId = p.rows[0].id as number;
  // Campaña de esta ventana: cosecha parcial 40/100 ha, rinde 168 tn, esperado 4.000 kg/ha.
  const pc = await pool.query(
    `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, harvested_at, harvest_ended_at,
                             yield_kg, harvested_hectares, expected_yield_kg_per_ha)
     VALUES ($1, 'soja', 2026, 'gruesa', CURRENT_DATE - 30, CURRENT_DATE - 1, CURRENT_DATE, 168000, 40, 4000) RETURNING id`,
    [norteId],
  );
  const pcId = pc.rows[0].id as number;
  const ev = await pool.query(
    `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop)
     VALUES ($1, $2, $3, 'harvest', CURRENT_DATE, 'soja') RETURNING id`,
    [u.userId, norteId, pcId],
  );
  await pool.query(
    `INSERT INTO harvest_loads (domain_event_id, plot_crop_id, driver_name, weight_kg, net_weight_kg, destinatario)
     VALUES ($1, $2, 'Pérez', 31320, 30321, 'Cargill'), ($1, $2, 'Gómez', 30000, 30000, 'Cargill')`,
    [ev.rows[0].id, pcId],
  );
  await pool.query(
    `INSERT INTO incomes (user_id, category, description, amount, currency, plot_id, income_date, buyer, quantity, unit, quantity_kg)
     VALUES ($1, 'Soja', 'venta', 15000, 'USD', $2, CURRENT_DATE, 'Cargill', 50, 'tn', 50000)`,
    [u.userId, norteId],
  );
  await pool.query(
    `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, crop, product, quantity, unit, notes)
     VALUES ($1, $2, 'grain_withdrawal', CURRENT_DATE, 'soja', 'Cargill', 5000, 'kg', 'semilla')`,
    [u.userId, norteId],
  );
  return { ...u, fieldId, norteId, call: api(u.token) };
}

async function cleanup(userId: number) {
  await pool.query(`DELETE FROM harvest_loads WHERE domain_event_id IN (SELECT id FROM domain_events WHERE user_id = $1)`, [userId]);
  await pool.query(`DELETE FROM domain_events WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM incomes WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM fields WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]).catch(() => {});
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
}

describe('GET /harvest-summary', () => {
  let a: Awaited<ReturnType<typeof seedUser>>;
  let b: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    if (!appUp) return;
    a = await seedUser('hs-a');
    b = await seedUser('hs-b');
  });
  afterAll(async () => {
    if (a) await cleanup(a.userId);
    if (b) await cleanup(b.userId);
  });

  it('devuelve la campaña con avance, rinde sobre lo cosechado, esperado vs real, fechas y camiones', async () => {
    if (!appUp) return;
    const r = await a.call('/harvest-summary');
    expect(r.status).toBe(200);
    const s = (await r.json()) as Summary;
    expect(s.campaigns).toHaveLength(1);
    const c = s.campaigns[0];
    expect(c.plotName).toBe('Norte');
    expect(c.crop).toBe('soja');
    expect(c.harvestedHectares).toBe(40);
    expect(c.progressPct).toBe(40);
    expect(c.yieldKg).toBe(168000);
    // 168.000 / 40 ha cosechadas (misma fórmula que el chat), no / 100.
    expect(c.yieldKgPerHa).toBe(4200);
    expect(c.expectedYieldKgPerHa).toBe(4000);
    expect(c.deviationPct).toBe(5);
    expect(c.harvestDays).toBe(2);
    expect(c.loads).toBe(2);
    expect(c.netKg).toBe(60321);
    expect(c.state).toBe('harvested');
  });

  it('saldo por acopio = entregado neto − vendido − retirado, y la lista de retiros', async () => {
    if (!appUp) return;
    const s = (await (await a.call('/harvest-summary')).json()) as Summary;
    const cargill = s.grainBalance.find(x => x.destinatario === 'Cargill');
    expect(cargill).toBeTruthy();
    expect(cargill!.deliveredKg).toBe(60321);
    expect(cargill!.soldKg).toBe(50000);
    expect(cargill!.withdrawnKg).toBe(5000);
    expect(cargill!.balanceKg).toBe(5321);
    expect(s.withdrawals).toHaveLength(1);
    expect(s.withdrawals[0].quantityKg).toBe(5000);
    expect(s.withdrawals[0].destinatario).toBe('Cargill');
  });

  it('scoping: un usuario no ve las campañas ni el saldo de otro; un campo ajeno devuelve vacío', async () => {
    if (!appUp) return;
    const s = (await (await b.call('/harvest-summary')).json()) as Summary;
    expect(s.campaigns.every(c => c.fieldId === b.fieldId)).toBe(true);
    expect(s.grainBalance.every(x => x.deliveredKg === 60321)).toBe(true); // el propio de b, no el de a sumado
    const foreign = (await (await b.call(`/harvest-summary?fieldId=${a.fieldId}`)).json()) as Summary;
    expect(foreign.campaigns).toEqual([]);
  });

  it('otra campaña (season) no trae la de este año', async () => {
    if (!appUp) return;
    const s = (await (await a.call('/harvest-summary?season=2023')).json()) as Summary;
    expect(s.campaigns).toEqual([]);
    expect(s.campaign.seasonYear).toBe(2023);
  });
});
