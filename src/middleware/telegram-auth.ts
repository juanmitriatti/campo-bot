import type { Request, Response, NextFunction } from 'express';

/**
 * Verify Telegram webhook requests using the secret token header.
 * If TELEGRAM_WEBHOOK_SECRET is not set, skip verification (dev mode).
 */
export function verifyTelegramWebhook(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    next();
    return;
  }

  const headerToken = req.headers['x-telegram-bot-api-secret-token'];
  if (headerToken !== secret) {
    console.warn('[telegram-auth] Invalid secret token');
    res.sendStatus(403);
    return;
  }

  next();
}
