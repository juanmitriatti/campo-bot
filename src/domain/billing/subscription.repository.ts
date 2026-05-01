import { pool } from '../../config/db.js';
import type { UserId } from '../../types/index.js';

export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired';
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
    // Mark any prior trial/active sub as cancelled — only one non-terminal at a time.
    await pool.query(
      `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND status IN ('trial', 'active', 'past_due')`,
      [input.userId],
    );
    const { rows } = await pool.query(
      `INSERT INTO subscriptions
         (user_id, plan_id, provider, provider_subscription_id, status, billing_period)
       VALUES ($1, $2, $3, $4, 'trial', $5)
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
  }): Promise<{ id: number; isNew: boolean }> {
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
      // Already existed — fetch its id for caller
      const existing = await pool.query(
        `SELECT id FROM payment_events WHERE provider = $1 AND provider_event_id = $2`,
        [input.provider, input.providerEventId],
      );
      return { id: existing.rows[0]?.id ?? 0, isNew: false };
    }
    return { id: rows[0].id, isNew: true };
  }

  async markEventProcessed(id: number, error?: string): Promise<void> {
    await pool.query(
      `UPDATE payment_events SET processed_at = NOW(), error = $2 WHERE id = $1`,
      [id, error ?? null],
    );
  }
}
