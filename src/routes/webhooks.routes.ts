import { Router, type Request, type Response } from 'express';
import express from 'express';
import { SubscriptionService, SubscriptionError } from '../domain/billing/subscription.service.js';
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
      res.sendStatus(200);
    } catch (err) {
      console.error('[webhook/mercadopago] error:', err);
      logError('webhook', 'MERCADOPAGO_FAILED', err as Error, {
        context: {
          headers: Object.keys(headers).filter(k => k.toLowerCase().startsWith('x-')),
        },
      });
      // Firma inválida → 401 (no es nuestro). Un fallo AL APLICAR el evento →
      // 500 para que MP reintente: el evento quedó con error y el reintento lo
      // reprocesa. Antes era 200 siempre y un pago que fallaba al aplicarse
      // quedaba cobrado sin plan (CTA-4). Lo que no se puede parsear ya
      // devuelve 200 desde el servicio sin tirar.
      res.sendStatus(err instanceof SubscriptionError ? err.status : 500);
    }
  },
);

export default router;
