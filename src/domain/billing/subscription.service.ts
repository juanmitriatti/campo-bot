import { pool, withTransaction } from '../../config/db.js';
import { PlanRepository } from './plan.repository.js';
import { FeatureGate } from './feature-gate.js';
import { MercadoPagoProvider } from './mercadopago.provider.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { getSetting, getSettingNumber, getSettingBool } from '../../services/settings.service.js';
import { logError } from '../../services/error-logger.js';
import type { PaymentProvider } from './payment-provider.js';
import type { UserId } from '../../types/index.js';
import type { BillingPeriod, SubscriptionRow } from './subscription.repository.js';

export class SubscriptionError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'SubscriptionError';
  }
}

const DEFAULT_TRIAL_DAYS = 14;
const DEFAULT_PAST_DUE_GRACE_DAYS = 3;

/**
 * Orchestrates the subscription lifecycle on top of a PaymentProvider.
 * Routes call this service; the service is the only thing that mutates plans
 * + subscriptions atomically.
 */
export class SubscriptionService {
  private plans: PlanRepository;
  private featureGate: FeatureGate;
  private repo: SubscriptionRepository;
  private provider: PaymentProvider;

  constructor(deps?: {
    plans?: PlanRepository;
    featureGate?: FeatureGate;
    repo?: SubscriptionRepository;
    provider?: PaymentProvider;
  }) {
    this.plans = deps?.plans ?? new PlanRepository();
    this.featureGate = deps?.featureGate ?? new FeatureGate();
    this.repo = deps?.repo ?? new SubscriptionRepository();
    this.provider = deps?.provider ?? new MercadoPagoProvider();
  }

  // ----- Trial bootstrap (called from AuthService.register) -----

  async createTrialIfMissing(userId: UserId, planName: string = 'pro'): Promise<void> {
    const enabled = await getSettingBool('PAYMENTS_ENABLED');
    if (!enabled) return;

    const trialDays = (await getSettingNumber('TRIAL_DAYS')) ?? DEFAULT_TRIAL_DAYS;
    if (trialDays <= 0) return;

    const existing = await this.repo.getActiveForUser(userId);
    if (existing) return;

    const plan = await this.plans.getPlanByName(planName as 'pro');
    if (!plan) {
      logError('subscriptions', 'TRIAL_PLAN_MISSING', new Error(`Plan ${planName} not found`), {
        userId,
      });
      return;
    }
    await this.repo.createTrial({ userId, planId: plan.id, trialDays });
    await this.plans.setUserPlan(userId, plan.id);
    this.featureGate.invalidateCache();
  }

  // ----- Status query -----

  async getStatus(userId: UserId): Promise<{
    subscription: SubscriptionRow | null;
    plan: { id: number; name: string; display_name: string; price_ars: number; price_ars_yearly: number | null } | null;
    payments_enabled: boolean;
  }> {
    const sub = await this.repo.getActiveForUser(userId);
    let plan = null;
    if (sub) {
      const planRow = await this.plans.getPlanById(sub.plan_id);
      if (planRow) {
        const yearly = await this.getPlanYearlyPrice(sub.plan_id);
        plan = {
          id: planRow.id,
          name: planRow.name,
          display_name: planRow.display_name,
          price_ars: Number(planRow.price_ars ?? 0),
          price_ars_yearly: yearly,
        };
      }
    }
    const payments_enabled = (await getSettingBool('PAYMENTS_ENABLED')) === true;
    return { subscription: sub, plan, payments_enabled };
  }

  // ----- Checkout flow -----

  async startCheckout(input: {
    userId: UserId;
    payerEmail: string;
    planName: string;
    billingPeriod: BillingPeriod;
  }): Promise<{ init_point: string; provider_subscription_id: string }> {
    const enabled = await getSettingBool('PAYMENTS_ENABLED');
    if (!enabled) {
      throw new SubscriptionError(503, 'PAYMENTS_DISABLED', 'Los pagos no están habilitados.');
    }
    if (!(await this.provider.isConfigured())) {
      throw new SubscriptionError(
        503,
        'PROVIDER_NOT_CONFIGURED',
        'El proveedor de pagos no está configurado. Contactá al administrador.',
      );
    }
    if (!input.payerEmail) {
      throw new SubscriptionError(400, 'EMAIL_REQUIRED', 'Necesitamos tu email para procesar el pago.');
    }

    const plan = await this.plans.getPlanByName(input.planName as 'pro');
    if (!plan) {
      throw new SubscriptionError(404, 'PLAN_NOT_FOUND', `Plan ${input.planName} no encontrado.`);
    }
    const monthly = Number(plan.price_ars ?? 0);
    if (monthly <= 0) {
      throw new SubscriptionError(400, 'PLAN_FREE', 'Este plan es gratuito, no necesita pago.');
    }
    const yearly = await this.getPlanYearlyPrice(plan.id);
    const priceArs = input.billingPeriod === 'yearly' && yearly ? yearly / 12 : monthly;

    const publicUrl = (await getSetting('PUBLIC_URL')) || 'https://campo-bot-production.up.railway.app';
    const result = await this.provider.createCheckout({
      userId: Number(input.userId),
      planName: plan.name,
      planDisplayName: plan.display_name,
      priceArs,
      billingPeriod: input.billingPeriod,
      payerEmail: input.payerEmail,
      successUrl: `${publicUrl.replace(/\/$/, '')}/dashboard?subscribed=1`,
      failureUrl: `${publicUrl.replace(/\/$/, '')}/dashboard?subscribed=0`,
    });

    await this.repo.createPending({
      userId: input.userId,
      planId: plan.id,
      provider: this.provider.name,
      providerSubscriptionId: result.provider_subscription_id,
      billingPeriod: input.billingPeriod,
    });

    return result;
  }

  // ----- Cancellation -----

  async cancel(userId: UserId): Promise<void> {
    const sub = await this.repo.getActiveForUser(userId);
    if (!sub) {
      throw new SubscriptionError(404, 'NO_SUBSCRIPTION', 'No tenés una suscripción activa.');
    }
    if (sub.provider === 'trial' || !sub.provider_subscription_id) {
      // Pure trial — just mark cancelled and downgrade to free immediately.
      await this.repo.updateStatus({ id: sub.id, status: 'cancelled' });
      await this.downgradeToFree(userId);
      return;
    }
    try {
      await this.provider.cancelSubscription(sub.provider_subscription_id);
    } catch (err) {
      // Don't fail the local cancel if provider already cancelled it.
      console.error('[subscription] provider cancel error:', err);
      logError('subscriptions', 'PROVIDER_CANCEL', err as Error, { userId });
    }
    await this.repo.updateStatus({ id: sub.id, status: 'cancelled' });
    // Access stays until current_period_end. Cron job downgrades plan when reached.
  }

  // ----- Webhook handling -----

  async handleWebhook(rawBody: Buffer | string, headers: Record<string, string | undefined>): Promise<void> {
    await this.provider.verifyWebhookSignature(rawBody, headers);
    let payload: unknown;
    try {
      const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      payload = JSON.parse(bodyStr);
    } catch {
      return; // not JSON — ignore
    }
    const outcome = await this.provider.parseWebhook(payload);
    if (!outcome) return;

    const sub = await this.repo.findByProviderId(outcome.provider_subscription_id);

    const eventId = (payload as { id?: string | number; data?: { id?: string | number } })?.data?.id
      ?? (payload as { id?: string | number })?.id
      ?? `${outcome.provider_subscription_id}_${Date.now()}`;
    const eventType = (payload as { type?: string; action?: string })?.type
      ?? (payload as { action?: string })?.action
      ?? 'unknown';

    const ev = await this.repo.insertPaymentEvent({
      provider: this.provider.name,
      providerEventId: String(eventId),
      eventType,
      subscriptionId: sub?.id ?? null,
      userId: sub?.user_id ?? null,
      payload,
    });
    if (!ev.isNew) return; // idempotent — already processed

    if (!sub) {
      await this.repo.markEventProcessed(ev.id, 'subscription not found');
      return;
    }

    try {
      await withTransaction(async () => {
        if (outcome.status) {
          await this.repo.updateStatus({
            id: sub.id,
            status: outcome.status,
            currentPeriodEnd: outcome.current_period_end,
          });
        }
        if (outcome.status === 'active') {
          await this.plans.setUserPlan(sub.user_id as UserId, sub.plan_id);
          this.featureGate.invalidateCache();
        }
        if (outcome.status === 'cancelled' || outcome.status === 'expired') {
          // Wait for current_period_end before actually downgrading. The cron
          // job (sweepExpired) handles that.
        }
      });
      await this.repo.markEventProcessed(ev.id);
    } catch (err) {
      await this.repo.markEventProcessed(ev.id, (err as Error).message);
      throw err;
    }
  }

  // ----- Daily cron sweep -----

  /**
   * Called by scheduler. Handles:
   *   - trial expired without payment → downgrade to free
   *   - past_due beyond grace window → cancel + downgrade
   *   - cancelled subs whose current_period_end has passed → downgrade
   */
  async sweepExpired(now: Date = new Date()): Promise<{ trialExpired: number; pastDueCancelled: number; cancelledDowngraded: number }> {
    let trialExpired = 0;
    let pastDueCancelled = 0;
    let cancelledDowngraded = 0;

    const expiringTrials = await this.repo.listExpiringTrials(now);
    for (const sub of expiringTrials) {
      await this.repo.updateStatus({ id: sub.id, status: 'expired' });
      await this.downgradeToFree(sub.user_id as UserId);
      trialExpired++;
    }

    const graceDays = (await getSettingNumber('PAST_DUE_GRACE_DAYS')) ?? DEFAULT_PAST_DUE_GRACE_DAYS;
    const stale = await this.repo.listPastDueGrace(graceDays, now);
    for (const sub of stale) {
      await this.repo.updateStatus({ id: sub.id, status: 'cancelled' });
      await this.downgradeToFree(sub.user_id as UserId);
      pastDueCancelled++;
    }

    // Active rows whose current_period_end already passed (paid sub but renewal failed silently).
    const { rows: passed } = await pool.query(
      `SELECT * FROM subscriptions
       WHERE status IN ('cancelled')
         AND current_period_end IS NOT NULL
         AND current_period_end < $1`,
      [now],
    );
    for (const sub of passed) {
      await this.downgradeToFree(sub.user_id as UserId);
      cancelledDowngraded++;
    }

    return { trialExpired, pastDueCancelled, cancelledDowngraded };
  }

  // ----- Helpers -----

  private async downgradeToFree(userId: UserId): Promise<void> {
    const free = await this.plans.getPlanByName('free');
    if (!free) return;
    await this.plans.setUserPlan(userId, free.id);
    this.featureGate.invalidateCache();
  }

  private async getPlanYearlyPrice(planId: number): Promise<number | null> {
    const { rows } = await pool.query(
      `SELECT price_ars_yearly FROM plans WHERE id = $1`,
      [planId],
    );
    const v = rows[0]?.price_ars_yearly;
    return v == null ? null : Number(v);
  }
}
