import webpush from 'web-push';
import { pool } from '../config/db.js';
import type { UserId } from '../types/index.js';

// VAPID keys — generate via: npx web-push generate-vapid-keys
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@campobot.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export class PushNotificationService {
  getVapidPublicKey(): string {
    return VAPID_PUBLIC_KEY;
  }

  async subscribe(userId: UserId, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
      [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );
  }

  async unsubscribe(userId: UserId, endpoint: string): Promise<void> {
    await pool.query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
      [userId, endpoint]
    );
  }

  async sendToUser(userId: UserId, title: string, body: string, data?: Record<string, unknown>): Promise<number> {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return 0;

    const { rows } = await pool.query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
      [userId]
    );

    let sent = 0;
    for (const sub of rows) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify({ title, body, data }),
        );
        sent++;
      } catch (err: unknown) {
        // Remove expired/invalid subscriptions
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        }
      }
    }
    return sent;
  }
}
