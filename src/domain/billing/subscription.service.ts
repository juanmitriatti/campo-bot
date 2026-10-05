import { pool, withTransaction } from '../../config/db.js';
import { PlanRepository } from './plan.repository.js';
import { FeatureGate } from './feature-gate.js';
import { MercadoPagoProvider } from './mercadopago.provider.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { getSetting, getSettingNumber, getSettingBool } from '../../services/settings.service.js';
import { getUserAccessMode, type AccessMode } from '../../services/access-gate.service.js';
import { getPlanCatalog, type PublicPlan } from './plan-catalog.service.js';
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
    console.log(`[TRIAL_STARTED] user=${userId} plan=${plan.name} days=${trialDays}`);
  }

  // ----- Status query -----

  async getStatus(userId: UserId): Promise<{
    subscription: SubscriptionRow | null;
    plan: { id: number; name: string; display_name: string; price_ars: number; price_ars_yearly: number | null } | null;
    payments_enabled: boolean;
    access_mode: AccessMode;
    plans: PublicPlan[];
    support_contact: string;
  }> {
    // Si no hay suscripción viva, cae a la última fila aunque esté vencida o
    // cancelada: el frontend necesita SABER que venció para levantar el
    // paywall. Con el filtro de estados vivos a secas, un vencido llegaba como
    // "usuario sin suscripción" y la tarjeta de Mi cuenta le escondía el botón
    // de pago — el único momento en que de verdad lo necesita.
    const sub = (await this.repo.getActiveForUser(userId)) ?? (await this.repo.getLatestForUser(userId));
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
    // El mismo gate que corta el bot decide el paywall del dashboard: dos
    // lecturas distintas de "está vencido" terminarían contradiciéndose.
    const access_mode = await getUserAccessMode(Number(userId));
    // El catálogo sale de la misma fuente que la landing — el modal no puede
    // ofrecer un precio distinto del que el usuario acaba de ver publicado.
    const { plans, support_contact } = await getPlanCatalog();
    return { subscription: sub, plan, payments_enabled, access_mode, plans, support_contact };
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
    try {
      await this.provider.verifyWebhookSignature(rawBody, headers);
    } catch (err) {
      // 401: la ruta no confunde una firma inválida con un fallo nuestro (500 = reintento).
      throw new SubscriptionError(401, 'INVALID_SIGNATURE', (err as Error).message);
    }
    let payload: unknown;
    try {
      const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      payload = JSON.parse(bodyStr);
    } catch {
      console.log('[BILLING] webhook ignorado: el cuerpo no es JSON');
      return;
    }
    const outcome = await this.provider.parseWebhook(payload);
    if (!outcome) {
      console.log('[BILLING] webhook ignorado: evento sin suscripción que aplicar');
      return;
    }

    const sub = await this.repo.findByProviderId(outcome.provider_subscription_id);

    // La clave de idempotencia es el ESTADO al que lleva el evento, no `data.id`
    // (CTA-1): MP manda 'created' y después 'authorized' con el MISMO data.id
    // (el de la preapproval), y el segundo se descartaba como duplicado — el
    // usuario pagaba y quedaba en prueba. El estado se lee de la API de MP (no
    // del payload), así que repetir la misma transición es inocuo; una
    // renovación cambia `current_period_end` y es otra clave.
    const periodKey = outcome.current_period_end ? outcome.current_period_end.toISOString().slice(0, 10) : '-';
    const eventId = `${outcome.provider_subscription_id}:${outcome.status ?? 'none'}:${periodKey}`;
    const eventType = (payload as { type?: string; action?: string })?.type
      ?? (payload as { action?: string })?.action
      ?? 'unknown';

    const ev = await this.repo.insertPaymentEvent({
      provider: this.provider.name,
      providerEventId: eventId,
      eventType,
      subscriptionId: sub?.id ?? null,
      userId: sub?.user_id ?? null,
      payload,
    });
    if (!ev.isNew && !ev.retry) {
      console.log(`[BILLING] webhook repetido ignorado: ${eventId}`);
      return;
    }
    if (ev.retry) console.log(`[BILLING] reintento de un evento que había fallado: ${eventId}`);

    if (!sub) {
      await this.repo.markEventProcessed(ev.id, 'subscription not found');
      console.log(`[BILLING] webhook sin suscripción local: ${outcome.provider_subscription_id}`);
      return;
    }

    let replaced: SubscriptionRow[] = [];
    try {
      await withTransaction(async () => {
        if (outcome.status === 'active') {
          // El pago autorizado REEMPLAZA lo vigente (CTA-3/4, decisión de
          // producto: sin prorrateo, el plan nuevo arranca cuando MP aprueba).
          replaced = await this.repo.activateReplacing(sub.id, outcome.current_period_end);
          await this.plans.setUserPlan(sub.user_id as UserId, sub.plan_id);
          this.featureGate.invalidateCache();
        } else if (outcome.status && sub.status === 'pending') {
          // Checkout abandonado o rechazado: nunca dio acceso, queda vencido.
          await this.repo.updateStatus({ id: sub.id, status: 'expired' });
        } else if (outcome.status) {
          // cancelled/expired esperan a current_period_end (sweepExpired baja el plan).
          await this.repo.updateStatus({
            id: sub.id,
            status: outcome.status,
            currentPeriodEnd: outcome.current_period_end,
          });
        }
      });
      await this.repo.markEventProcessed(ev.id);
    } catch (err) {
      await this.repo.markEventProcessed(ev.id, (err as Error).message);
      throw err;
    }

    if (replaced.length > 0) {
      console.log(`[BILLING] user=${sub.user_id} sub=${sub.id} activa; reemplazó ${replaced.map((r) => `${r.id}(${r.status})`).join(', ')}`);
      await this.cancelAtProvider(replaced, sub.user_id);
    }
  }

  /**
   * Cancela en el proveedor los cobros recurrentes de filas retiradas. Sin
   * esto, pasar de mensual a anual o de Pro a Pro+ seguía cobrando el plan
   * viejo (CTA-3). Best-effort: un fallo queda en el log de errores.
   */
  private async cancelAtProvider(rows: SubscriptionRow[], userId: number): Promise<void> {
    for (const r of rows) {
      if (r.provider !== this.provider.name || !r.provider_subscription_id) continue;
      try {
        await this.provider.cancelSubscription(r.provider_subscription_id);
        console.log(`[BILLING] cancelado en ${r.provider}: ${r.provider_subscription_id} (sub ${r.id})`);
      } catch (err) {
        logError('subscriptions', 'PROVIDER_CANCEL_REPLACED', err as Error, { userId, context: { subId: r.id } });
      }
    }
  }

  /**
   * Plan asignado por el admin (CTA-9). Un plan pago sin cobro por MP queda
   * como suscripción 'manual' activa, que destraba una prueba vencida (antes
   * solo cambiaba `users.plan_id` y el access-gate seguía en solo-lectura). Si
   * el usuario ya paga por MP no se toca su suscripción (cancelarla cortaría un
   * cobro real): solo cambia el plan.
   */
  async assignPlanByAdmin(userId: UserId, planId: number): Promise<void> {
    const plan = await this.plans.getPlanById(planId);
    if (!plan) throw new SubscriptionError(404, 'PLAN_NOT_FOUND', 'Plan no encontrado.');
    await this.plans.setUserPlan(userId, planId);
    this.featureGate.invalidateCache();
    if (Number(plan.price_ars ?? 0) <= 0 && plan.name === 'free') return;
    const live = await this.repo.getActiveForUser(userId);
    if (live && live.provider === this.provider.name && (live.status === 'active' || live.status === 'past_due')) {
      console.log(`[BILLING] admin: user=${userId} ya paga por ${live.provider}; solo cambia el plan a ${plan.name}`);
      return;
    }
    await withTransaction(async () => {
      await this.repo.createManualActive(userId, planId);
    });
    console.log(`[BILLING] admin: user=${userId} plan ${plan.name} manual activo`);
  }

  /**
   * Prueba para un usuario nuevo creado por cualquier camino que no sea el
   * registro web (alta del admin, primer mensaje por chat). Sin fila de
   * suscripción el access-gate lo trata como pre-billing: acceso pleno para
   * siempre (CTA-15).
   */
  async startTrialForNewUser(userId: UserId): Promise<void> {
    const trialPlanName = (await getSetting('TRIAL_PLAN_NAME')) || 'pro';
    await this.createTrialIfMissing(userId, trialPlanName);
  }

  /** Cuenta borrada (CTA-6): se retira todo y se corta el cobro en MP. */
  async closeForDeletedAccount(userId: UserId): Promise<void> {
    const closed = await this.repo.closeAllForUser(userId);
    if (closed.length > 0) console.log(`[BILLING] cuenta borrada user=${userId}: cerradas ${closed.map((r) => r.id).join(', ')}`);
    await this.cancelAtProvider(closed, Number(userId));
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

    // Cada fila en su propio try (CRN-17): una que falla no corta el resto ni
    // queda muda.
    const each = async (label: string, sub: SubscriptionRow, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        console.error(`[BILLING] sweep ${label} sub=${sub.id} falló:`, (err as Error).message);
        logError('subscriptions', 'SWEEP_ROW_FAILED', err as Error, { userId: sub.user_id, context: { subId: sub.id, label } });
      }
    };

    const expiringTrials = await this.repo.listExpiringTrials(now);
    for (const sub of expiringTrials) {
      await each('trial', sub, async () => {
        await this.repo.updateStatus({ id: sub.id, status: 'expired' });
        await this.downgradeToFree(sub.user_id as UserId);
        console.log(`[TRIAL_EXPIRED] user=${sub.user_id} sub_id=${sub.id} via=cron_sweep`);
        trialExpired++;
      });
    }

    const graceDays = (await getSettingNumber('PAST_DUE_GRACE_DAYS')) ?? DEFAULT_PAST_DUE_GRACE_DAYS;
    const stale = await this.repo.listPastDueGrace(graceDays, now);
    for (const sub of stale) {
      await each('past_due', sub, async () => {
        await this.repo.updateStatus({ id: sub.id, status: 'cancelled' });
        await this.downgradeToFree(sub.user_id as UserId);
        pastDueCancelled++;
      });
    }

    // Canceladas cuyo período pago ya terminó. Antes se recorrían TODAS las
    // canceladas viejas cada noche y se bajaba a free a quien tenía además una
    // suscripción nueva activa (CTA-5/CRN-1). Ahora: se cierran (expired, así
    // no se vuelven a procesar) y solo se baja el plan si no hay otra viva.
    const { rows: passed } = await pool.query(
      `SELECT * FROM subscriptions
       WHERE status = 'cancelled'
         AND current_period_end IS NOT NULL
         AND current_period_end < $1`,
      [now],
    );
    for (const sub of passed as SubscriptionRow[]) {
      await each('cancelled', sub, async () => {
        await this.repo.updateStatus({ id: sub.id, status: 'expired' });
        if (await this.repo.hasLiveSubscription(sub.user_id as UserId)) {
          console.log(`[BILLING] sweep: sub=${sub.id} cerrada sin bajar el plan (user=${sub.user_id} tiene otra vigente)`);
          return;
        }
        await this.downgradeToFree(sub.user_id as UserId);
        cancelledDowngraded++;
      });
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
