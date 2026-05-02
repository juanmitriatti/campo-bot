/**
 * Abstract payment provider interface. Concrete providers (MercadoPago, Stripe…)
 * implement this. SubscriptionService is the only consumer.
 */
export interface CheckoutInput {
  userId: number;
  planName: string;
  planDisplayName: string;
  priceArs: number;
  billingPeriod: 'monthly' | 'yearly';
  payerEmail: string;
  successUrl: string;
  failureUrl: string;
}

export interface CheckoutResult {
  /** URL the user is sent to in order to authorise the recurring charge. */
  init_point: string;
  /** Provider-specific subscription identifier (MP preapproval id). */
  provider_subscription_id: string;
}

export interface WebhookEvent {
  /** Stable id for idempotency (e.g. MP "id" or "data.id" depending on event type). */
  event_id: string;
  event_type: string;
  raw: unknown;
}

/**
 * Status mapped from a provider event into our subscription state machine.
 */
export interface ParsedWebhookOutcome {
  /** The provider_subscription_id this event applies to. */
  provider_subscription_id: string;
  /** New subscription status, if the provider tells us it changed. */
  status?: 'active' | 'past_due' | 'cancelled' | 'expired';
  /** Next renewal date, if known. */
  current_period_end?: Date;
}

export interface PaymentProvider {
  readonly name: string;

  /**
   * Whether this provider has live credentials configured. When false the
   * SubscriptionService can short-circuit checkouts with a friendly message
   * instead of failing later in the flow.
   */
  isConfigured(): Promise<boolean>;

  /**
   * Create a recurring charge URL the user can be redirected to.
   */
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;

  /**
   * Cancel the recurring charge. The subscription stays active until
   * current_period_end (caller's responsibility to enforce that).
   */
  cancelSubscription(providerSubscriptionId: string): Promise<void>;

  /**
   * Validate a webhook signature header against the raw body. Throws if invalid.
   */
  verifyWebhookSignature(rawBody: Buffer | string, headers: Record<string, string | undefined>): Promise<void>;

  /**
   * Parse a webhook payload into our domain shape. Returns null if the event
   * is something we don't act on (e.g. a "test" ping).
   */
  parseWebhook(payload: unknown): Promise<ParsedWebhookOutcome | null>;

  /**
   * Refund a previously processed payment. Optional: not every provider has
   * a public refund API; SubscriptionService never calls this — only the
   * admin support endpoint does.
   *
   * @param providerPaymentId — provider-specific payment id (NOT the
   *   subscription id). For MercadoPago this is the `id` returned by
   *   `/v1/payments/:id`.
   * @param amountArs — partial refund amount. Omit to refund the full amount.
   */
  refund?(providerPaymentId: string, amountArs?: number): Promise<RefundResult>;
}

export interface RefundResult {
  /** Provider-side refund id, useful for cross-referencing in the dashboard. */
  refund_id: string;
  /** Status returned by the provider (approved, pending, rejected, …). */
  status: string;
  /** Effective amount refunded, in ARS. */
  amount_ars: number;
}
