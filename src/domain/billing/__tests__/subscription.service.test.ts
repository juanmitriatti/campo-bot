import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '../../../types/index.js';

const mockQuery = vi.fn();
vi.mock('../../../config/db.js', () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));

const settingsValues: Record<string, string | number | boolean | null> = {
  PAYMENTS_ENABLED: true,
  TRIAL_DAYS: 14,
  PUBLIC_URL: 'https://test.local',
  PAST_DUE_GRACE_DAYS: 3,
  TRIAL_PLAN_NAME: 'pro',
};
vi.mock('../../../services/settings.service.js', () => ({
  getSetting: vi.fn(async (k: string) => settingsValues[k] as string | undefined),
  getSettingNumber: vi.fn(async (k: string) => settingsValues[k] as number | undefined),
  getSettingBool: vi.fn(async (k: string) => settingsValues[k] === true),
}));

import { SubscriptionService, SubscriptionError } from '../subscription.service.js';

const userId = 1 as UserId;

function makePlanRepo() {
  return {
    getAllPlans: vi.fn().mockResolvedValue([]),
    getPlanByName: vi.fn(async (name: string) => {
      if (name === 'free') return { id: 1, name: 'free', display_name: 'Gratis', price_ars: 0 };
      if (name === 'pro') return { id: 2, name: 'pro', display_name: 'Pro', price_ars: 9999 };
      return null;
    }),
    getPlanById: vi.fn(async (id: number) => ({
      id, name: id === 2 ? 'pro' : 'free', display_name: id === 2 ? 'Pro' : 'Gratis', price_ars: id === 2 ? 9999 : 0,
    })),
    setUserPlan: vi.fn().mockResolvedValue(undefined),
    getUserPlan: vi.fn(),
    getPlanFeatures: vi.fn().mockResolvedValue([]),
    getAllFeatures: vi.fn(),
    setPlanFeatures: vi.fn(),
    createPlan: vi.fn(),
    getUserPlanAiLimit: vi.fn(),
    updatePlan: vi.fn(),
  };
}

function makeFeatureGate() {
  return {
    invalidateCache: vi.fn(),
    hasFeature: vi.fn().mockResolvedValue(true),
    getUserFeatures: vi.fn().mockResolvedValue([]),
    getUserPlan: vi.fn(),
  };
}

function makeRepo() {
  return {
    getActiveForUser: vi.fn(),
    getById: vi.fn(),
    findByProviderId: vi.fn(),
    createTrial: vi.fn(),
    createPending: vi.fn(),
    updateStatus: vi.fn(),
    listExpiringTrials: vi.fn().mockResolvedValue([]),
    listPastDueGrace: vi.fn().mockResolvedValue([]),
    insertPaymentEvent: vi.fn(),
    markEventProcessed: vi.fn(),
  };
}

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    name: 'mercadopago',
    isConfigured: vi.fn().mockResolvedValue(true),
    createCheckout: vi.fn().mockResolvedValue({
      init_point: 'https://mp/checkout/abc',
      provider_subscription_id: 'mp_sub_123',
    }),
    cancelSubscription: vi.fn().mockResolvedValue(undefined),
    verifyWebhookSignature: vi.fn().mockResolvedValue(undefined),
    parseWebhook: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('SubscriptionService.createTrialIfMissing', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('skips when PAYMENTS_ENABLED=false', async () => {
    settingsValues.PAYMENTS_ENABLED = false;
    const plans = makePlanRepo();
    const repo = makeRepo();
    const svc = new SubscriptionService({ plans: plans as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: makeProvider() as any });
    await svc.createTrialIfMissing(userId, 'pro');
    expect(repo.createTrial).not.toHaveBeenCalled();
    settingsValues.PAYMENTS_ENABLED = true;
  });

  it('skips when user already has an active subscription', async () => {
    const repo = makeRepo();
    repo.getActiveForUser.mockResolvedValueOnce({ id: 1, user_id: 1, plan_id: 2, status: 'active' });
    const plans = makePlanRepo();
    const svc = new SubscriptionService({ plans: plans as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: makeProvider() as any });
    await svc.createTrialIfMissing(userId, 'pro');
    expect(repo.createTrial).not.toHaveBeenCalled();
  });

  it('creates a trial and bumps the user to the trial plan', async () => {
    const repo = makeRepo();
    repo.getActiveForUser.mockResolvedValueOnce(null);
    repo.createTrial.mockResolvedValueOnce({ id: 7, user_id: 1, plan_id: 2, status: 'trial' });
    const plans = makePlanRepo();
    const fg = makeFeatureGate();
    const svc = new SubscriptionService({ plans: plans as any, repo: repo as any, featureGate: fg as any, provider: makeProvider() as any });

    await svc.createTrialIfMissing(userId, 'pro');

    expect(repo.createTrial).toHaveBeenCalledWith({ userId, planId: 2, trialDays: 14 });
    expect(plans.setUserPlan).toHaveBeenCalledWith(userId, 2);
    expect(fg.invalidateCache).toHaveBeenCalled();
  });
});

describe('SubscriptionService.startCheckout', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('rejects when PAYMENTS_ENABLED=false', async () => {
    settingsValues.PAYMENTS_ENABLED = false;
    const svc = new SubscriptionService({ plans: makePlanRepo() as any, repo: makeRepo() as any, featureGate: makeFeatureGate() as any, provider: makeProvider() as any });
    await expect(svc.startCheckout({ userId, payerEmail: 'a@b.c', planName: 'pro', billingPeriod: 'monthly' }))
      .rejects.toThrow(SubscriptionError);
    settingsValues.PAYMENTS_ENABLED = true;
  });

  it('rejects when provider is not configured', async () => {
    const svc = new SubscriptionService({
      plans: makePlanRepo() as any, repo: makeRepo() as any, featureGate: makeFeatureGate() as any,
      provider: makeProvider({ isConfigured: vi.fn().mockResolvedValue(false) }) as any,
    });
    await expect(svc.startCheckout({ userId, payerEmail: 'a@b.c', planName: 'pro', billingPeriod: 'monthly' }))
      .rejects.toThrow(/no está configurado/);
  });

  it('rejects when plan is free (price 0)', async () => {
    const plans = makePlanRepo();
    plans.getPlanByName = vi.fn().mockResolvedValue({ id: 1, name: 'free', display_name: 'Gratis', price_ars: 0 });
    const svc = new SubscriptionService({ plans: plans as any, repo: makeRepo() as any, featureGate: makeFeatureGate() as any, provider: makeProvider() as any });
    await expect(svc.startCheckout({ userId, payerEmail: 'a@b.c', planName: 'free', billingPeriod: 'monthly' }))
      .rejects.toThrow(/gratuito/);
  });

  it('creates a pending subscription and returns init_point', async () => {
    const repo = makeRepo();
    repo.createPending.mockResolvedValueOnce({ id: 11, user_id: 1, plan_id: 2, status: 'trial' });
    mockQuery.mockResolvedValueOnce({ rows: [{ price_ars_yearly: null }] }); // yearly lookup
    const provider = makeProvider();
    const svc = new SubscriptionService({ plans: makePlanRepo() as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: provider as any });

    const r = await svc.startCheckout({ userId, payerEmail: 'a@b.c', planName: 'pro', billingPeriod: 'monthly' });

    expect(r.init_point).toBe('https://mp/checkout/abc');
    expect(provider.createCheckout).toHaveBeenCalled();
    expect(repo.createPending).toHaveBeenCalledWith(expect.objectContaining({
      userId, planId: 2, provider: 'mercadopago', providerSubscriptionId: 'mp_sub_123', billingPeriod: 'monthly',
    }));
  });
});

describe('SubscriptionService.cancel', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('rejects when no subscription exists', async () => {
    const repo = makeRepo();
    repo.getActiveForUser.mockResolvedValueOnce(null);
    const svc = new SubscriptionService({ plans: makePlanRepo() as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: makeProvider() as any });
    await expect(svc.cancel(userId)).rejects.toThrow(/No tenés una suscripción/);
  });

  it('cancels a pure trial immediately + downgrades to free', async () => {
    const repo = makeRepo();
    repo.getActiveForUser.mockResolvedValueOnce({
      id: 5, user_id: 1, plan_id: 2, provider: 'trial', provider_subscription_id: null, status: 'trial',
    });
    const plans = makePlanRepo();
    const fg = makeFeatureGate();
    const svc = new SubscriptionService({ plans: plans as any, repo: repo as any, featureGate: fg as any, provider: makeProvider() as any });

    await svc.cancel(userId);

    expect(repo.updateStatus).toHaveBeenCalledWith({ id: 5, status: 'cancelled' });
    expect(plans.setUserPlan).toHaveBeenCalledWith(userId, 1); // free plan id
  });

  it('calls provider.cancelSubscription for paid subs without immediate downgrade', async () => {
    const repo = makeRepo();
    repo.getActiveForUser.mockResolvedValueOnce({
      id: 5, user_id: 1, plan_id: 2, provider: 'mercadopago', provider_subscription_id: 'mp_X', status: 'active',
    });
    const plans = makePlanRepo();
    const provider = makeProvider();
    const svc = new SubscriptionService({ plans: plans as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: provider as any });

    await svc.cancel(userId);

    expect(provider.cancelSubscription).toHaveBeenCalledWith('mp_X');
    expect(repo.updateStatus).toHaveBeenCalledWith({ id: 5, status: 'cancelled' });
    // No immediate plan downgrade — that happens at current_period_end via cron sweep.
    expect(plans.setUserPlan).not.toHaveBeenCalled();
  });
});

describe('SubscriptionService.handleWebhook', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('is idempotent (duplicate event = noop)', async () => {
    const repo = makeRepo();
    repo.findByProviderId.mockResolvedValueOnce({ id: 9, user_id: 1, plan_id: 2 });
    repo.insertPaymentEvent.mockResolvedValueOnce({ id: 100, isNew: false });
    const provider = makeProvider({
      parseWebhook: vi.fn().mockResolvedValue({
        provider_subscription_id: 'mp_sub_X',
        status: 'active',
      }),
    });
    const plans = makePlanRepo();
    const svc = new SubscriptionService({ plans: plans as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: provider as any });

    const body = JSON.stringify({ id: 'evt_1', type: 'preapproval.updated', data: { id: 'mp_sub_X' } });
    await svc.handleWebhook(body, {});

    expect(repo.updateStatus).not.toHaveBeenCalled(); // duplicate skipped
    expect(plans.setUserPlan).not.toHaveBeenCalled();
  });

  it('activates user plan on status=active webhook', async () => {
    const repo = makeRepo();
    repo.findByProviderId.mockResolvedValueOnce({ id: 9, user_id: 1, plan_id: 2 });
    repo.insertPaymentEvent.mockResolvedValueOnce({ id: 100, isNew: true });
    const provider = makeProvider({
      parseWebhook: vi.fn().mockResolvedValue({
        provider_subscription_id: 'mp_sub_X',
        status: 'active',
        current_period_end: new Date('2026-06-01'),
      }),
    });
    const plans = makePlanRepo();
    const fg = makeFeatureGate();
    const svc = new SubscriptionService({ plans: plans as any, repo: repo as any, featureGate: fg as any, provider: provider as any });

    const body = JSON.stringify({ id: 'evt_1', type: 'preapproval.updated', data: { id: 'mp_sub_X' } });
    await svc.handleWebhook(body, {});

    expect(repo.updateStatus).toHaveBeenCalledWith({
      id: 9, status: 'active', currentPeriodEnd: new Date('2026-06-01'),
    });
    expect(plans.setUserPlan).toHaveBeenCalledWith(1, 2);
    expect(fg.invalidateCache).toHaveBeenCalled();
    expect(repo.markEventProcessed).toHaveBeenCalledWith(100);
  });

  it('does NOT downgrade on cancelled webhook (waits for period_end)', async () => {
    const repo = makeRepo();
    repo.findByProviderId.mockResolvedValueOnce({ id: 9, user_id: 1, plan_id: 2 });
    repo.insertPaymentEvent.mockResolvedValueOnce({ id: 101, isNew: true });
    const provider = makeProvider({
      parseWebhook: vi.fn().mockResolvedValue({
        provider_subscription_id: 'mp_sub_X',
        status: 'cancelled',
      }),
    });
    const plans = makePlanRepo();
    const svc = new SubscriptionService({ plans: plans as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: provider as any });

    await svc.handleWebhook(JSON.stringify({ id: 'evt_2', data: { id: 'mp_sub_X' } }), {});

    expect(repo.updateStatus).toHaveBeenCalledWith({
      id: 9, status: 'cancelled', currentPeriodEnd: undefined,
    });
    expect(plans.setUserPlan).not.toHaveBeenCalled(); // downgrade is deferred
  });
});

describe('SubscriptionService.sweepExpired', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('expires trials and downgrades to free', async () => {
    const repo = makeRepo();
    repo.listExpiringTrials.mockResolvedValueOnce([
      { id: 1, user_id: 11, plan_id: 2, status: 'trial' },
      { id: 2, user_id: 22, plan_id: 2, status: 'trial' },
    ]);
    repo.listPastDueGrace.mockResolvedValueOnce([]);
    mockQuery.mockResolvedValueOnce({ rows: [] }); // passed cancelled query
    const plans = makePlanRepo();
    const svc = new SubscriptionService({ plans: plans as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: makeProvider() as any });

    const r = await svc.sweepExpired();

    expect(r.trialExpired).toBe(2);
    expect(repo.updateStatus).toHaveBeenCalledTimes(2);
    expect(plans.setUserPlan).toHaveBeenCalledTimes(2);
  });

  it('cancels past_due beyond grace window', async () => {
    const repo = makeRepo();
    repo.listExpiringTrials.mockResolvedValueOnce([]);
    repo.listPastDueGrace.mockResolvedValueOnce([
      { id: 5, user_id: 7, plan_id: 2, status: 'past_due' },
    ]);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const plans = makePlanRepo();
    const svc = new SubscriptionService({ plans: plans as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: makeProvider() as any });

    const r = await svc.sweepExpired();

    expect(r.pastDueCancelled).toBe(1);
    expect(repo.updateStatus).toHaveBeenCalledWith({ id: 5, status: 'cancelled' });
    expect(plans.setUserPlan).toHaveBeenCalled();
  });
});

/**
 * Regresión (Ago 2026): `/subscription` filtraba por estados VIVOS, así que a
 * un usuario con la prueba vencida le llegaba `subscription: null` y
 * `plan: null`. Con eso, la tarjeta de Mi cuenta escondía el botón de pago y el
 * banner del Resumen no mostraba nada — el único momento en que el usuario
 * necesita pagar era justo el momento en que no podía. En prod había 9
 * suscripciones `expired` y 2 payment_events.
 */
describe('SubscriptionService.getStatus', () => {
  const EXPIRED_SUB = {
    id: 9, user_id: 1, plan_id: 2, status: 'expired',
    provider: 'trial', provider_subscription_id: null,
    billing_period: 'monthly', trial_ends_at: new Date('2026-08-01'),
    current_period_end: null, cancelled_at: null, metadata: null,
    created_at: new Date('2026-07-18'), updated_at: new Date('2026-08-01'),
  };

  const CATALOG_ROWS = [
    { name: 'pro', display_name: 'Pro', price_ars: 5000, price_ars_yearly: null, daily_ai_limit: 100, daily_document_limit: 10, is_featured: false, custom_pricing: false },
    { name: 'pro_plus', display_name: 'Pro+', price_ars: 12000, price_ars_yearly: 100000, daily_ai_limit: 300, daily_document_limit: 25, is_featured: true, custom_pricing: false },
  ];

  beforeEach(async () => {
    mockQuery.mockReset();
    // El catálogo cachea 60s a nivel módulo: sin esto, un test se lleva puesto
    // el payload del anterior.
    const { invalidatePlanCatalogCache } = await import('../plan-catalog.service.js');
    invalidatePlanCatalogCache();
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM subscriptions/i.test(sql)) return { rows: [EXPIRED_SUB] };
      if (/is_active AND is_public/i.test(sql)) return { rows: CATALOG_ROWS };
      if (/price_ars_yearly FROM plans/i.test(sql)) return { rows: [{ price_ars_yearly: null }] };
      return { rows: [] };
    });
  });

  it('devuelve la suscripción vencida y su plan (sin esto no hay dónde pagar)', async () => {
    const repo = makeRepo();
    repo.getActiveForUser.mockResolvedValue(null);
    (repo as any).getLatestForUser = vi.fn().mockResolvedValue(EXPIRED_SUB);
    const svc = new SubscriptionService({ plans: makePlanRepo() as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: makeProvider() as any });

    const status = await svc.getStatus(userId);

    expect(status.subscription?.status).toBe('expired');
    expect(status.plan?.name).toBe('pro');
    expect(status.access_mode).toBe('trial_expired_readonly');
    expect(status.plans.map(p => p.name)).toEqual(['pro', 'pro_plus']);
  });

  it('no consulta la fila terminal cuando hay una suscripción viva', async () => {
    const live = { ...EXPIRED_SUB, status: 'trial', trial_ends_at: new Date(Date.now() + 5 * 86400000) };
    const repo = makeRepo();
    repo.getActiveForUser.mockResolvedValue(live);
    (repo as any).getLatestForUser = vi.fn();
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM subscriptions/i.test(sql)) return { rows: [live] };
      if (/is_active AND is_public/i.test(sql)) return { rows: CATALOG_ROWS };
      return { rows: [{ price_ars_yearly: null }] };
    });
    const svc = new SubscriptionService({ plans: makePlanRepo() as any, repo: repo as any, featureGate: makeFeatureGate() as any, provider: makeProvider() as any });

    const status = await svc.getStatus(userId);

    expect((repo as any).getLatestForUser).not.toHaveBeenCalled();
    expect(status.access_mode).toBe('full');
  });
});
