/**
 * Cobro con MercadoPago (auditoría oct 2026, CTA-1..6/9, CRN-1). Contra la DB
 * real, con un proveedor falso que hace de MP: lo que se prueba es la máquina
 * de estados de `subscriptions`, no la API de MP.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../../services/settings.service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../services/settings.service.js')>();
  return {
    ...orig,
    getSettingBool: vi.fn(async (k: string) => (k === 'PAYMENTS_ENABLED' ? true : orig.getSettingBool(k))),
  };
});

import { pool } from '../../../config/db.js';
import { SubscriptionService } from '../subscription.service.js';
import { getUserAccessMode } from '../../../services/access-gate.service.js';
import type { UserId } from '../../../types/index.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

type Outcome = { provider_subscription_id: string; status?: 'active' | 'past_due' | 'cancelled' | 'expired'; current_period_end?: Date };

function makeProvider() {
  let next: Outcome | null = null;
  let seq = 0;
  return {
    name: 'mercadopago',
    cancelled: [] as string[],
    setOutcome(o: Outcome) { next = o; },
    isConfigured: async () => true,
    createCheckout: async () => ({ init_point: 'https://mp.test/checkout', provider_subscription_id: `pre_${Date.now()}_${++seq}` }),
    cancelSubscription: async function (id: string) { (this as { cancelled: string[] }).cancelled.push(id); },
    verifyWebhookSignature: async () => {},
    parseWebhook: async () => next,
  };
}

describe.skipIf(!dbAvailable)('cobro: máquina de estados de la suscripción', () => {
  let provider: ReturnType<typeof makeProvider>;
  let svc: SubscriptionService;
  let userId: number;
  let plan: Record<string, number>;
  const webhook = (o: Outcome) => {
    provider.setOutcome(o);
    return svc.handleWebhook(JSON.stringify({ type: 'subscription_preapproval', data: { id: o.provider_subscription_id } }), {});
  };
  const subs = async () =>
    (await pool.query(`SELECT id, status, provider, provider_subscription_id, plan_id FROM subscriptions WHERE user_id = $1 ORDER BY id`, [userId])).rows;
  const userPlan = async () => (await pool.query(`SELECT plan_id FROM users WHERE id = $1`, [userId])).rows[0].plan_id;
  const checkout = async (planName = 'pro', billingPeriod: 'monthly' | 'yearly' = 'monthly') =>
    svc.startCheckout({ userId: userId as UserId, payerEmail: 'pago@test.local', planName, billingPeriod });

  beforeAll(async () => {
    const { rows } = await pool.query(`SELECT id, name FROM plans`);
    plan = Object.fromEntries(rows.map((r: { id: number; name: string }) => [r.name, r.id]));
  });

  beforeEach(async () => {
    provider = makeProvider();
    svc = new SubscriptionService({ provider: provider as never });
    if (userId) {
      await pool.query(`DELETE FROM payment_events WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM subscriptions WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    const u = await pool.query(
      `INSERT INTO users (name, email, password_hash, plan_id) VALUES ('Pagador', $1, 'x', $2) RETURNING id`,
      [`pagador-${Date.now()}@test.local`, plan.free],
    );
    userId = u.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM payment_events WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM subscriptions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it('CTA-2: abrir el checkout y no pagar no toca la prueba vigente', async () => {
    await svc.createTrialIfMissing(userId as UserId, 'pro_plus');
    await checkout();
    const rows = await subs();
    expect(rows.map((r) => r.status)).toEqual(['trial', 'pending']);
    expect(await getUserAccessMode(userId)).toBe('full');
  });

  it('CTA-1: el "authorized" que llega después del "created" con el mismo id activa el plan', async () => {
    const { provider_subscription_id: pre } = await checkout();
    await webhook({ provider_subscription_id: pre }); // created (sin cambio de estado)
    await webhook({ provider_subscription_id: pre, status: 'active', current_period_end: new Date('2026-11-04') });
    expect((await subs()).find((r) => r.provider_subscription_id === pre)?.status).toBe('active');
    expect(await userPlan()).toBe(plan.pro);
  });

  it('CTA-3: pasar a otro plan cancela el cobro viejo en MP (sin doble cobro)', async () => {
    const { provider_subscription_id: a } = await checkout('pro', 'monthly');
    await webhook({ provider_subscription_id: a, status: 'active', current_period_end: new Date('2026-11-04') });
    const { provider_subscription_id: b } = await checkout('pro_plus', 'yearly');
    // Mientras no paga el nuevo, sigue con el viejo.
    expect((await subs()).find((r) => r.provider_subscription_id === a)?.status).toBe('active');
    await webhook({ provider_subscription_id: b, status: 'active', current_period_end: new Date('2027-10-04') });
    const rows = await subs();
    expect(rows.find((r) => r.provider_subscription_id === a)?.status).toBe('cancelled');
    expect(rows.find((r) => r.provider_subscription_id === b)?.status).toBe('active');
    expect(provider.cancelled).toEqual([a]);
    expect(await userPlan()).toBe(plan.pro_plus);
  });

  it('CTA-4: pagar un link viejo activa ESE checkout y vence el otro, sin chocar el índice', async () => {
    const { provider_subscription_id: viejo } = await checkout();
    const { provider_subscription_id: nuevo } = await checkout();
    await webhook({ provider_subscription_id: viejo, status: 'active', current_period_end: new Date('2026-11-04') });
    const rows = await subs();
    expect(rows.find((r) => r.provider_subscription_id === viejo)?.status).toBe('active');
    expect(rows.find((r) => r.provider_subscription_id === nuevo)?.status).toBe('expired');
    expect(provider.cancelled).toContain(nuevo);
    expect(await getUserAccessMode(userId)).toBe('full');
  });

  it('CTA-4: un evento que falla al aplicarse se reprocesa en el reintento', async () => {
    const { provider_subscription_id: pre } = await checkout();
    const failing = new SubscriptionService({
      provider: provider as never,
      featureGate: { invalidateCache: () => { throw new Error('falla transitoria'); } } as never,
    });
    provider.setOutcome({ provider_subscription_id: pre, status: 'active', current_period_end: new Date('2026-11-04') });
    await expect(failing.handleWebhook(JSON.stringify({ data: { id: pre }, type: 'subscription_preapproval' }), {})).rejects.toThrow();
    expect((await subs()).find((r) => r.provider_subscription_id === pre)?.status).toBe('pending');

    await webhook({ provider_subscription_id: pre, status: 'active', current_period_end: new Date('2026-11-04') });
    expect((await subs()).find((r) => r.provider_subscription_id === pre)?.status).toBe('active');
  });

  it('CTA-5/CRN-1: el sweep no baja a free a quien tiene una cancelada vieja y una activa nueva', async () => {
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, provider, provider_subscription_id, status, current_period_end, created_at)
       VALUES ($1, $2, 'mercadopago', 'pre_viejo', 'cancelled', NOW() - INTERVAL '10 days', NOW() - INTERVAL '40 days')`,
      [userId, plan.pro],
    );
    const { provider_subscription_id: pre } = await checkout('pro_plus');
    await webhook({ provider_subscription_id: pre, status: 'active', current_period_end: new Date(Date.now() + 30 * 864e5) });
    await svc.sweepExpired();
    await svc.sweepExpired();
    expect(await userPlan()).toBe(plan.pro_plus);
    expect((await subs()).find((r) => r.provider_subscription_id === 'pre_viejo')?.status).toBe('expired');
  });

  it('CTA-6: borrar la cuenta cierra la suscripción y corta el cobro en MP', async () => {
    const { provider_subscription_id: pre } = await checkout();
    await webhook({ provider_subscription_id: pre, status: 'active', current_period_end: new Date('2026-11-04') });
    await svc.closeForDeletedAccount(userId as UserId);
    expect((await subs()).every((r) => r.status === 'cancelled' || r.status === 'expired')).toBe(true);
    expect(provider.cancelled).toContain(pre);
  });

  it('CTA-9: el plan que asigna el admin destraba una prueba vencida', async () => {
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, provider, status, trial_ends_at)
       VALUES ($1, $2, 'trial', 'expired', NOW() - INTERVAL '1 day')`,
      [userId, plan.pro_plus],
    );
    expect(await getUserAccessMode(userId)).toBe('trial_expired_readonly');
    await svc.assignPlanByAdmin(userId as UserId, plan.pro);
    expect(await getUserAccessMode(userId)).toBe('full');
    expect(await userPlan()).toBe(plan.pro);
    expect((await subs()).some((r) => r.provider === 'manual' && r.status === 'active')).toBe(true);
  });

  it('un checkout abandonado que MP da por cancelado queda vencido, sin tocar lo vigente', async () => {
    await svc.createTrialIfMissing(userId as UserId, 'pro_plus');
    const { provider_subscription_id: pre } = await checkout();
    await webhook({ provider_subscription_id: pre, status: 'cancelled' });
    const rows = await subs();
    expect(rows.find((r) => r.provider_subscription_id === pre)?.status).toBe('expired');
    expect(rows.find((r) => r.provider === 'trial')?.status).toBe('trial');
  });
});
