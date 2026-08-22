import { pool } from '../config/db.js';
import { sendMessageWithRetry } from './whatsapp.js';
import { sendTelegramMessage } from './telegram.js';
import { logError } from './error-logger.js';

/**
 * Phase 1 — soft-block transparente.
 *
 * Sends one-shot warnings to a user when they cross 80% (warning) or 100%
 * (hit) of their daily AI quota. Notifications are deduped to ONCE per
 * calendar day per user using a partial UPDATE in user_settings.
 *
 * Race-safety: the dedup is enforced by a single SQL UPDATE that only
 * matches rows whose stamp is NULL or older than today. The UPDATE returns
 * the affected row only when this caller is the winner, so concurrent
 * messages from the same user can't double-fire the warning.
 *
 * Channel selection: prefer Telegram (faster delivery, no template
 * restrictions), fall back to WhatsApp. If the user has neither linked,
 * log a warn and move on — we're not blocking the main pipeline on
 * notification delivery.
 */

export type LimitNotificationKind = 'warning' | 'hit';

interface UserChannels {
  phone: string | null;
  telegram_id: string | null;
}

async function loadChannels(userId: number): Promise<UserChannels | null> {
  const { rows } = await pool.query(
    `SELECT phone_number AS phone, telegram_id FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Atomically claim the right to send a notification for `kind` today.
 * Returns true when this caller won the race (and therefore should send),
 * false when another caller already won (or the user has no settings row).
 */
async function claimNotification(userId: number, kind: LimitNotificationKind): Promise<boolean> {
  const column = kind === 'warning' ? 'last_limit_warning_at' : 'last_limit_hit_at';
  const result = await pool.query(
    `UPDATE user_settings
        SET ${column} = CURRENT_DATE
      WHERE user_id = $1
        AND (${column} IS NULL OR ${column} < CURRENT_DATE)
      RETURNING user_id`,
    [userId],
  );
  if (result.rowCount && result.rowCount > 0) return true;

  // No row matched: either someone else won today, OR the user has no
  // user_settings row yet. Distinguish those two cases so we don't silently
  // skip first-time notifications.
  const existing = await pool.query(
    `SELECT 1 FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  if (existing.rowCount === 0) {
    // Insert a fresh row stamped to today and claim the win.
    await pool.query(
      `INSERT INTO user_settings (user_id, ${column}) VALUES ($1, CURRENT_DATE)
       ON CONFLICT (user_id) DO UPDATE SET ${column} = EXCLUDED.${column}
         WHERE user_settings.${column} IS NULL OR user_settings.${column} < CURRENT_DATE`,
      [userId],
    );
    // Re-check that we won (defensive; covers a race between INSERT…ON CONFLICT
    // calls). If another writer beat us between our SELECT and INSERT, the
    // ON CONFLICT WHERE clause makes this a no-op for the loser.
    const verify = await pool.query(
      `SELECT ${column} FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    const stampedToday = verify.rows[0]?.[column];
    return !!stampedToday;
  }
  return false;
}

async function sendOnPreferredChannel(channels: UserChannels, message: string): Promise<{ ok: boolean; reason?: string }> {
  if (channels.telegram_id) {
    try {
      await sendTelegramMessage(channels.telegram_id, message);
      return { ok: true };
    } catch (err) {
      // Fall through to WhatsApp if available.
      const reason = err instanceof Error ? err.message : String(err);
      if (!channels.phone || channels.phone.startsWith('tg_')) {
        return { ok: false, reason: `tg failed: ${reason}` };
      }
    }
  }
  if (channels.phone && !channels.phone.startsWith('tg_')) {
    const phone = channels.phone.startsWith('+') ? channels.phone.slice(1) : channels.phone;
    // sendMessageWithRetry sale por return dentro del loop: si se agotan los
    // reintentos sin entrar a ninguna rama devuelve undefined.
    const result = await sendMessageWithRetry(phone, message);
    if (result?.success) return { ok: true };
    return { ok: false, reason: `wa failed: ${result?.error ?? 'sin respuesta'}` };
  }
  return { ok: false, reason: 'no_channel' };
}

interface NotifyArgs {
  userId: number;
  used: number;
  limit: number;
  planName?: string | null;
}

const PRIMARY_CTA = 'Para tener acceso completo escribinos desde tu cuenta:';
const ACCOUNT_URL_HINT = 'https://campo-bot-production.up.railway.app/dashboard';

function warningCopy({ used, limit }: NotifyArgs): string {
  const remaining = Math.max(0, limit - used);
  return (
    `💡 *Te quedan ${remaining} mensajes inteligentes hoy*\n\n` +
    `Llevás ${used} de ${limit} mensajes con IA. ` +
    `Cuando se agoten, voy a seguir respondiendo cosas básicas hasta mañana.\n\n` +
    `Si necesitás más, ${PRIMARY_CTA}\n${ACCOUNT_URL_HINT}`
  );
}

function hitCopy({ limit }: NotifyArgs): string {
  return (
    `🤖 *Llegaste al tope diario de IA*\n\n` +
    `Usaste tus ${limit} mensajes inteligentes de hoy. Voy a seguir aceptando ` +
    `*registros simples y consultas básicas*, pero algunas funciones ` +
    `(cosechas, hacienda, edits, OCR avanzado) quedan limitadas hasta mañana.\n\n` +
    `Si te pasa seguido, ${PRIMARY_CTA}\n${ACCOUNT_URL_HINT}`
  );
}

export class LimitNotifierService {
  /**
   * Best-effort: when the user has just consumed enough calls to cross 80%
   * of their daily limit, drop a single advisory message in their channel.
   * Caller decides when to invoke; this service does NOT compute thresholds.
   */
  async maybeNotifyWarning(args: NotifyArgs): Promise<void> {
    try {
      console.log(`[LIMIT_WARNING] user=${args.userId} used=${args.used} limit=${args.limit} plan=${args.planName ?? 'unknown'}`);
      const claimed = await claimNotification(args.userId, 'warning');
      if (!claimed) return;
      const channels = await loadChannels(args.userId);
      if (!channels) return;
      const result = await sendOnPreferredChannel(channels, warningCopy(args));
      if (!result.ok) {
        console.warn(`[LIMIT_WARNING_SEND_FAILED] user=${args.userId} reason=${result.reason}`);
      }
    } catch (err) {
      // Never let notification failures escape — they must not break the main pipeline.
      logError('limits', 'WARNING_NOTIFY_FAILED', err as Error, { userId: args.userId });
    }
  }

  /**
   * Same dedup contract as warning, fired when daily count >= limit.
   * The bot will keep responding via regex; this just makes the rate-limit
   * visible to the user.
   */
  async maybeNotifyHit(args: NotifyArgs): Promise<void> {
    try {
      console.log(`[LIMIT_HIT] user=${args.userId} used=${args.used} limit=${args.limit} plan=${args.planName ?? 'unknown'}`);
      const claimed = await claimNotification(args.userId, 'hit');
      if (!claimed) return;
      const channels = await loadChannels(args.userId);
      if (!channels) return;
      const result = await sendOnPreferredChannel(channels, hitCopy(args));
      if (!result.ok) {
        console.warn(`[LIMIT_HIT_SEND_FAILED] user=${args.userId} reason=${result.reason}`);
      }
    } catch (err) {
      logError('limits', 'HIT_NOTIFY_FAILED', err as Error, { userId: args.userId });
    }
  }
}

// Singleton instance — the service is stateless apart from DB access.
export const limitNotifier = new LimitNotifierService();
