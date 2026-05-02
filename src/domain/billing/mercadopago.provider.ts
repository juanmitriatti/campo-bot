import crypto from 'crypto';
import { getSetting } from '../../services/settings.service.js';
import type {
  CheckoutInput,
  CheckoutResult,
  ParsedWebhookOutcome,
  PaymentProvider,
} from './payment-provider.js';

// Override via env for tests. Production stays on api.mercadopago.com.
const MP_API_BASE = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com';

interface MpPreapprovalResponse {
  id: string;
  init_point: string;
  status?: string;
  next_payment_date?: string;
}

interface MpPreapprovalDetail {
  id: string;
  status: string;
  next_payment_date?: string;
  end_date?: string;
}

/**
 * MercadoPago provider — uses the Preapproval (subscriptions) API.
 * Docs: https://www.mercadopago.com.ar/developers/es/reference/subscriptions/_preapproval/post
 */
export class MercadoPagoProvider implements PaymentProvider {
  readonly name = 'mercadopago';

  async isConfigured(): Promise<boolean> {
    const token = (await getSetting('MP_ACCESS_TOKEN'))?.trim();
    return !!token && token.length > 10;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const token = (await getSetting('MP_ACCESS_TOKEN'))?.trim();
    if (!token) {
      throw new Error('MP_ACCESS_TOKEN no configurado');
    }
    const publicUrl = (await getSetting('PUBLIC_URL')) || 'https://campo-bot-production.up.railway.app';
    const webhookUrl = `${publicUrl.replace(/\/$/, '')}/webhooks/mercadopago`;

    const frequency = input.billingPeriod === 'yearly' ? 12 : 1;
    const period = input.billingPeriod === 'yearly' ? 'years' : 'months';
    const transactionAmount = input.billingPeriod === 'yearly'
      // Yearly = 10 months equivalent (16% discount). Plan editor can override price_ars_yearly.
      ? Number((input.priceArs * 12).toFixed(2))
      : Number(input.priceArs.toFixed(2));

    const body = {
      reason: `Campo Bot — Plan ${input.planDisplayName}`,
      external_reference: `user_${input.userId}_${input.planName}_${Date.now()}`,
      payer_email: input.payerEmail,
      back_url: input.successUrl,
      auto_recurring: {
        frequency: input.billingPeriod === 'yearly' ? 1 : 1,
        frequency_type: input.billingPeriod === 'yearly' ? 'years' : 'months',
        transaction_amount: transactionAmount,
        currency_id: 'ARS',
      },
      notification_url: webhookUrl,
      status: 'pending',
    };

    const res = await fetch(`${MP_API_BASE}/preapproval`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '<no body>');
      throw new Error(`MP createCheckout failed (${res.status}): ${errText.slice(0, 300)}`);
    }
    const json = (await res.json()) as MpPreapprovalResponse;
    if (!json.id || !json.init_point) {
      throw new Error('MP returned incomplete preapproval response');
    }
    return {
      init_point: json.init_point,
      provider_subscription_id: json.id,
    };
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    const token = (await getSetting('MP_ACCESS_TOKEN'))?.trim();
    if (!token) throw new Error('MP_ACCESS_TOKEN no configurado');

    const res = await fetch(`${MP_API_BASE}/preapproval/${providerSubscriptionId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    if (!res.ok && res.status !== 404) {
      const txt = await res.text().catch(() => '');
      throw new Error(`MP cancel failed (${res.status}): ${txt.slice(0, 200)}`);
    }
  }

  /**
   * MercadoPago signs webhooks with HMAC-SHA256 over a constructed message.
   * Header `x-signature` looks like: "ts=1700000000,v1=<hex>".
   * If MP_WEBHOOK_SECRET is empty (sandbox / unverified mode) we skip the check.
   */
  async verifyWebhookSignature(
    rawBody: Buffer | string,
    headers: Record<string, string | undefined>,
  ): Promise<void> {
    const secret = (await getSetting('MP_WEBHOOK_SECRET'))?.trim();
    if (!secret) return; // open mode — leave a warning in admin

    const sigHeader = headers['x-signature'] || headers['X-Signature'];
    const requestId = headers['x-request-id'] || headers['X-Request-Id'];
    if (!sigHeader) throw new Error('Missing x-signature header');

    const parts = Object.fromEntries(
      sigHeader.split(',').map(pair => pair.trim().split('=', 2)) as [string, string][],
    );
    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1) throw new Error('Malformed x-signature header');

    // MP manifest format: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
    // We don't always know data.id at this layer; tolerate by trying both:
    // empty id and id from body if present.
    const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    let dataId: string | null = null;
    try {
      const parsed = JSON.parse(bodyStr) as { data?: { id?: string }; id?: string };
      dataId = parsed?.data?.id ?? parsed?.id ?? null;
    } catch {
      /* ignore */
    }

    const candidates = [
      `id:${dataId ?? ''};request-id:${requestId ?? ''};ts:${ts};`,
      `id:${dataId ?? ''};ts:${ts};`,
    ];

    const ok = candidates.some(msg => {
      const expected = crypto.createHmac('sha256', secret).update(msg).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
    });
    if (!ok) throw new Error('Invalid webhook signature');
  }

  async parseWebhook(payload: unknown): Promise<ParsedWebhookOutcome | null> {
    const body = payload as {
      type?: string;
      action?: string;
      data?: { id?: string };
      id?: string;
    };
    const eventType = body?.type ?? body?.action ?? '';
    const dataId = body?.data?.id ?? body?.id;
    if (!dataId) return null;

    // We only act on subscription state changes. "payment" events update the
    // current_period_end but the heavy lifting comes from preapproval polling.
    if (eventType.includes('preapproval') || eventType.includes('subscription')) {
      const detail = await this.fetchPreapproval(String(dataId));
      if (!detail) return null;
      return {
        provider_subscription_id: detail.id,
        status: this.mapStatus(detail.status),
        current_period_end: detail.next_payment_date ? new Date(detail.next_payment_date) : undefined,
      };
    }

    return null;
  }

  private async fetchPreapproval(id: string): Promise<MpPreapprovalDetail | null> {
    const token = (await getSetting('MP_ACCESS_TOKEN'))?.trim();
    if (!token) return null;
    const res = await fetch(`${MP_API_BASE}/preapproval/${id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as MpPreapprovalDetail;
  }

  private mapStatus(mpStatus: string): ParsedWebhookOutcome['status'] | undefined {
    switch ((mpStatus || '').toLowerCase()) {
      case 'authorized':
        return 'active';
      case 'paused':
        return 'past_due';
      case 'cancelled':
        return 'cancelled';
      case 'finished':
        return 'expired';
      default:
        return undefined;
    }
  }
}
