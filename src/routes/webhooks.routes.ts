import { Router, type Request, type Response } from 'express';
import express from 'express';
import { SubscriptionService } from '../domain/billing/subscription.service.js';
import { logError } from '../services/error-logger.js';

const router = Router();
const subscriptions = new SubscriptionService();

/**
 * MercadoPago webhook. Receives preapproval / subscription / payment events.
 * Body parser is `express.raw` so signature verification has access to the
 * exact bytes MP signed.
 */
router.post(
  '/mercadopago',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;
    const headers = req.headers as Record<string, string | undefined>;
    try {
      await subscriptions.handleWebhook(rawBody, headers);
      // MP retries on non-2xx — always ack quickly.
      res.sendStatus(200);
    } catch (err) {
      console.error('[webhook/mercadopago] error:', err);
      logError('webhook', 'MERCADOPAGO_FAILED', err as Error, {
        context: {
          headers: Object.keys(headers).filter(k => k.toLowerCase().startsWith('x-')),
        },
      });
      // Return 200 anyway — we logged it; MP would otherwise hammer us with retries
      // for events we'll never be able to parse (test pings, deprecated formats).
      res.sendStatus(200);
    }
  },
);

export default router;
