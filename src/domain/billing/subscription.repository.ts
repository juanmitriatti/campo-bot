import { pool } from '../../config/db.js';
import type { UserId } from '../../types/index.js';

/** 'pending' = checkout abierto en el proveedor, todavía sin pagar (migración 130). */
export type SubscriptionStatus = 'pending' | 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired';
export type BillingPeriod = 'monthly' | 'yearly';

export interface SubscriptionRow {
  id: number;
  user_id: number;
  plan_id: number;
  provider: string;
  provider_subscription_id: string | null;
  status: SubscriptionStatus;
  billing_period: BillingPeriod;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  cancelled_at: Date | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export class SubscriptionRepository {
  async getActiveForUser(userId: UserId): Promise<SubscriptionRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM subscriptions
       WHERE user_id = $1 AND status IN ('trial', 'active', 'past_due')
       ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /**
   * La última fila del usuario, INCLUIDAS las terminales (expired/cancelled).
   *
   * `getActiveForUser` filtra por estados vivos, y eso dejaba a un vencido con
   * `subscription: null` en `/subscription` — o sea sin plan, sin banner y sin
   * botón de pago, justo en el único momento en que tiene que poder pagar.
   * Para decidir acceso se sigue usando el access-gate, no esta fila.
   */
  async getLatestForUser(userId: UserId): Promise<SubscriptionRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM subscriptions
       WHERE user_id = $1 AND status <> 'pending'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async getById(id: number): Promise<SubscriptionRow | null> {
    const { rows } = await pool.query(`SELECT * FROM subscriptions WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async findByProviderId(providerSubId: string): Promise<SubscriptionRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM subscriptions WHERE provider_subscription_id = $1 ORDER BY id DESC LIMIT 1`,
      [providerSubId],
    );
    return rows[0] ?? null;
  }

  async createTrial(input: {
    userId: UserId;
    planId: number;
    trialDays: number;
  }): Promise<SubscriptionRow> {
    const trialEnd = new Date(Date.now() + input.trialDays * 24 * 60 * 60 * 1000);
    const { rows } = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, provider, status, billing_period, trial_ends_at)
       VALUES ($1, $2, 'trial', 'trial', 'monthly', $3)
       RETURNING *`,
      [input.userId, input.planId, trialEnd],
    );
    return rows[0];
  }

  async createPending(input: {
    userId: UserId;
    planId: number;
    provider: string;
    providerSubscriptionId: string;
    billingPeriod: BillingPeriod;
  }): Promise<SubscriptionRow> {
    // La vigente NO se toca (CTA-2): abrir el checkout y no pagar dejaba la
    // cuenta en solo-lectura. Se reemplaza recién cuando el pago se autoriza
    // (`activateReplacing`).
    const { rows } = await pool.query(
      `INSERT INTO subscriptions
         (user_id, plan_id, provider, provider_subscription_id, status, billing_period)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING *`,
      [input.userId, input.planId, input.provider, input.providerSubscriptionId, input.billingPeriod],
    );
    return rows[0];
  }

  async updateStatus(input: {
    id: number;
    status: SubscriptionStatus;
    currentPeriodEnd?: Date;
  }): Promise<void> {
    await pool.query(
      `UPDATE subscriptions
       SET status = $2::varchar,
           current_period_end = COALESCE($3, current_period_end),
           cancelled_at = CASE WHEN $2::varchar = 'cancelled' THEN NOW() ELSE cancelled_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [input.id, input.status, input.currentPeriodEnd ?? null],
    );
  }

  /**
   * Activa `id` y retira todas las demás filas vivas o pendientes del usuario
   * (CTA-3/CTA-4): las vivas pasan a 'cancelled', los checkouts sin pagar a
   * 'expired'. Primero se retiran las otras, así el índice único de filas
   * vivas no choca aunque se pague un link viejo. Devuelve lo retirado (el
   * llamador cancela en el proveedor lo que cobraba). Llamar dentro de una
   * transacción.
   */
  async activateReplacing(id: number, currentPeriodEnd?: Date): Promise<SubscriptionRow[]> {
    const { rows: target } = await pool.query(`SELECT user_id FROM subscriptions WHERE id = $1 FOR UPDATE`, [id]);
    if (target.length === 0) return [];
    const { rows: replaced } = await pool.query(
      `UPDATE subscriptions
          SET status = CASE WHEN status = 'pending' THEN 'expired' ELSE 'cancelled' END,
              cancelled_at = CASE WHEN status = 'pending' THEN cancelled_at ELSE NOW() END,
              updated_at = NOW()
        WHERE user_id = $1 AND id <> $2 AND status IN ('pending', 'trial', 'active', 'past_due')
        RETURNING *`,
      [target[0].user_id, id],
    );
    await pool.query(
      `UPDATE subscriptions
          SET status = 'active', cancelled_at = NULL,
              current_period_end = COALESCE($2, current_period_end), updated_at = NOW()
        WHERE id = $1`,
      [id, currentPeriodEnd ?? null],
    );
    return replaced;
  }

  /**
   * Plan asignado a mano por el admin (CTA-9): una fila 'manual' activa sin
   * vencimiento, que reemplaza la vigente. Sin esto el plan del admin no
   * destrababa una prueba vencida (el acceso lo decide la suscripción).
   */
  async createManualActive(userId: UserId, planId: number): Promise<{ row: SubscriptionRow; replaced: SubscriptionRow[] }> {
    const { rows } = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, provider, status, billing_period)
       VALUES ($1, $2, 'manual', 'pending', 'monthly')
       RETURNING *`,
      [userId, planId],
    );
    const replaced = await this.activateReplacing(rows[0].id);
    return { row: { ...rows[0], status: 'active' }, replaced };
  }

  /** Retira todo lo vivo o pendiente del usuario (cuenta borrada, CTA-6). */
  async closeAllForUser(userId: UserId): Promise<SubscriptionRow[]> {
    const { rows } = await pool.query(
      `UPDATE subscriptions
          SET status = CASE WHEN status = 'pending' THEN 'expired' ELSE 'cancelled' END,
              cancelled_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND status IN ('pending', 'trial', 'active', 'past_due')
        RETURNING *`,
      [userId],
    );
    return rows;
  }

  /** ¿Tiene una suscripción viva (trial/active/past_due)? */
  async hasLiveSubscription(userId: UserId): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1 FROM subscriptions WHERE user_id = $1 AND status IN ('trial', 'active', 'past_due') LIMIT 1`,
      [userId],
    );
    return rows.length > 0;
  }

  async listExpiringTrials(now: Date = new Date()): Promise<SubscriptionRow[]> {
    const { rows } = await pool.query(
      `SELECT * FROM subscriptions
       WHERE status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < $1`,
      [now],
    );
    return rows;
  }

  async listPastDueGrace(graceDays: number, now: Date = new Date()): Promise<SubscriptionRow[]> {
    const { rows } = await pool.query(
      `SELECT * FROM subscriptions
       WHERE status = 'past_due'
         AND updated_at < $1::timestamptz - ($2::int || ' days')::interval`,
      [now, graceDays],
    );
    return rows;
  }

  // ---- Payment events (idempotent log) ----

  async insertPaymentEvent(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    subscriptionId: number | null;
    userId: number | null;
    payload: unknown;
  }): Promise<{ id: number; isNew: boolean; retry: boolean }> {
    const { rows } = await pool.query(
      `INSERT INTO payment_events
         (provider, provider_event_id, event_type, subscription_id, user_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [
        input.provider,
        input.providerEventId,
        input.eventType,
        input.subscriptionId,
        input.userId,
        JSON.stringify(input.payload),
      ],
    );
    if (rows.length === 0) {
      // Ya existía. Si quedó con error o sin procesar, se REINTENTA: antes un
      // fallo dejaba el evento "visto" para siempre y el pago no se aplicaba
      // nunca (CTA-4).
      const existing = await pool.query(
        `SELECT id, processed_at, error FROM payment_events WHERE provider = $1 AND provider_event_id = $2`,
        [input.provider, input.providerEventId],
      );
      const row = existing.rows[0];
      return { id: row?.id ?? 0, isNew: false, retry: !!row && (row.processed_at == null || row.error != null) };
    }
    return { id: rows[0].id, isNew: true, retry: false };
  }

  async markEventProcessed(id: number, error?: string): Promise<void> {
    await pool.query(
      `UPDATE payment_events SET processed_at = NOW(), error = $2 WHERE id = $1`,
      [id, error ?? null],
    );
  }
}
