import { pool } from "../config/db.js";
import { sendMessageWithRetry } from "./whatsapp.js";
import { sendTelegramMessage } from "./telegram.ts";
import { logError } from "./error-logger.js";

// Tipos de alerta que el usuario puede apagar con "no más alertas".
// Los resúmenes (weekly/monthly), avisos de flow y recordatorios NO se gatean acá.
const PROACTIVE_ALERT_TYPES = new Set([
  'weather', 'monitoring_reminder', 'pest_escalation',
  'missing_hectares', 'low_stock', 'phenology',
]);

export const OPT_OUT_FOOTER = '\n\n_Para dejar de recibir estos avisos: «no más alertas»._';

export function isProactiveAlertType(alertType) {
  return PROACTIVE_ALERT_TYPES.has(alertType);
}

async function userAllowsProactiveAlerts(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(alerts_enabled, TRUE) AS ok FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  return rows.length === 0 ? true : rows[0].ok !== false;
}

/**
 * Send an alert with retry and persist to alert_history.
 *
 * @param {number} userId
 * @param {string} phone - WhatsApp phone number
 * @param {string} message - Alert text
 * @param {string} alertType - 'weather', 'budget_80', 'budget_100', 'monitoring_reminder', 'pest_escalation'
 * @param {object} metadata - { fieldId, plotId, dedupKey, payload }
 * @returns {Promise<{sent: boolean, alertId: number}>}
 */
export async function sendAlertWithRetry(userId, phone, message, alertType, metadata = {}) {
  if (isProactiveAlertType(alertType)) {
    if (!(await userAllowsProactiveAlerts(userId))) {
      console.log(`[alert.service] [INTERCEPT] alerta '${alertType}' salteada para user ${userId} (opt-out)`);
      return { sent: false, skipped: 'opt_out' };
    }
    message = message + OPT_OUT_FOOTER;
  }

  const { fieldId = null, plotId = null, dedupKey = null, payload = {} } = metadata;

  // Insert initial record
  const { rows } = await pool.query(
    `INSERT INTO alert_history (user_id, alert_type, field_id, plot_id, message, payload, status, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'retrying', $7)
     RETURNING id`,
    [userId, alertType, fieldId, plotId, message, JSON.stringify(payload), dedupKey]
  );
  const alertId = rows[0].id;

  // Handle Telegram-only users (tg_ placeholder phones or null phones)
  let telegramId = null;
  if (phone && phone.startsWith('tg_')) {
    telegramId = phone.slice(3);
  } else if (!phone) {
    // Try to find Telegram ID from user record
    const userResult = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [userId]);
    if (userResult.rows[0]?.telegram_id) {
      telegramId = userResult.rows[0].telegram_id;
    }
  }

  let result;
  if (telegramId) {
    // Route to Telegram
    try {
      await sendTelegramMessage(telegramId, message);
      result = { success: true, attempts: 1 };
    } catch (err) {
      result = { success: false, attempts: 1, error: err.message };
    }
  } else if (phone) {
    result = await sendMessageWithRetry(phone, message);
  } else {
    result = { success: false, attempts: 0, error: 'No phone or Telegram ID available' };
  }

  if (result.success) {
    await pool.query(
      `UPDATE alert_history SET status = 'sent', retry_count = $1, delivered_at = NOW() WHERE id = $2`,
      [result.attempts - 1, alertId]
    );
    return { sent: true, alertId };
  }

  // Final failure
  await pool.query(
    `UPDATE alert_history SET status = 'failed', retry_count = $1 WHERE id = $2`,
    [result.attempts, alertId]
  );
  logError('alerts', 'ALERT_SEND_FAILED', new Error(result.error), {
    userId, alertType, alertId,
    context: { phone, attempts: result.attempts },
  });
  return { sent: false, alertId };
}

/**
 * Send an alert via Telegram or WhatsApp, with retry and persistence.
 *
 * @param {number} userId
 * @param {{ phone?: string, telegramId?: string }} channels
 * @param {string} message
 * @param {string} alertType
 * @param {object} metadata
 * @returns {Promise<{sent: boolean, alertId: number}>}
 */
export async function sendAlertWithRetryMultiChannel(userId, { phone, telegramId: rawTelegramId }, message, alertType, metadata = {}) {
  if (isProactiveAlertType(alertType)) {
    if (!(await userAllowsProactiveAlerts(userId))) {
      console.log(`[alert.service] [INTERCEPT] alerta '${alertType}' salteada para user ${userId} (opt-out)`);
      return { sent: false, skipped: 'opt_out' };
    }
    message = message + OPT_OUT_FOOTER;
  }

  // Detect tg_ placeholder phone numbers and extract telegramId
  let telegramId = rawTelegramId;
  if (!telegramId && phone && phone.startsWith('tg_')) {
    telegramId = phone.slice(3);
  }
  const { fieldId = null, plotId = null, dedupKey = null, payload = {} } = metadata;

  const { rows } = await pool.query(
    `INSERT INTO alert_history (user_id, alert_type, field_id, plot_id, message, payload, status, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'retrying', $7)
     RETURNING id`,
    [userId, alertType, fieldId, plotId, message, JSON.stringify(payload), dedupKey]
  );
  const alertId = rows[0].id;

  let sent = false;
  let channel = '';

  if (telegramId) {
    channel = 'telegram';
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await sendTelegramMessage(telegramId, message);
        sent = true;
        break;
      } catch (err) {
        if (attempt === maxAttempts) {
          logError('alerts', 'ALERT_SEND_FAILED', err, {
            userId, alertType, alertId,
            context: { channel: 'telegram', telegramId, attempts: maxAttempts },
          });
        } else {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
  } else if (phone) {
    channel = 'whatsapp';
    const result = await sendMessageWithRetry(phone, message);
    if (result.success) {
      sent = true;
    } else {
      logError('alerts', 'ALERT_SEND_FAILED', new Error(result.error), {
        userId, alertType, alertId,
        context: { channel: 'whatsapp', phone, attempts: result.attempts },
      });
    }
  } else {
    console.warn(`[alert] User ${userId} has no phone or telegramId — skipping alert`);
    await pool.query(
      `UPDATE alert_history SET status = 'failed', retry_count = 0 WHERE id = $1`,
      [alertId]
    );
    return { sent: false, alertId };
  }

  // Push notification (best effort, no retry needed)
  try {
    const { PushNotificationService } = await import('./push-notification.service.js');
    const pushSvc = new PushNotificationService();
    await pushSvc.sendToUser(userId, 'Campo Bot', message.replace(/\*/g, '').replace(/_/g, '').slice(0, 200));
  } catch (pushErr) {
    // Silently fail — push is supplementary
  }

  if (sent) {
    await pool.query(
      `UPDATE alert_history SET status = 'sent', delivered_at = NOW() WHERE id = $1`,
      [alertId]
    );
    return { sent: true, alertId };
  }

  await pool.query(
    `UPDATE alert_history SET status = 'failed' WHERE id = $1`,
    [alertId]
  );
  return { sent: false, alertId };
}

/**
 * Record an alert that was already sent inline (e.g., budget alerts sent as reply).
 */
export async function recordAlert(userId, alertType, message, metadata = {}) {
  const { fieldId = null, plotId = null, dedupKey = null, payload = {} } = metadata;
  const { rows } = await pool.query(
    `INSERT INTO alert_history (user_id, alert_type, field_id, plot_id, message, payload, status, dedup_key, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'sent', $7, NOW())
     RETURNING id`,
    [userId, alertType, fieldId, plotId, message, JSON.stringify(payload), dedupKey]
  );
  return rows[0].id;
}

/**
 * Check if a matching alert was already sent within the dedup window.
 *
 * @param {number} userId
 * @param {string} alertType
 * @param {string} dedupKey
 * @param {number} windowHours - default 24
 * @returns {Promise<boolean>}
 */
export async function isDuplicate(userId, alertType, dedupKey, windowHours = 24) {
  const { rows } = await pool.query(
    `SELECT 1 FROM alert_history
     WHERE user_id = $1
       AND alert_type = $2
       AND dedup_key = $3
       AND status = 'sent'
       AND created_at > NOW() - $4::int * INTERVAL '1 hour'
     LIMIT 1`,
    [userId, alertType, dedupKey, windowHours]
  );
  return rows.length > 0;
}

/**
 * Record a deduped (skipped) alert for tracking.
 */
export async function recordDeduped(userId, alertType, dedupKey, message = '') {
  await pool.query(
    `INSERT INTO alert_history (user_id, alert_type, message, status, dedup_key)
     VALUES ($1, $2, $3, 'deduped', $4)`,
    [userId, alertType, message, dedupKey]
  );
}

/**
 * Get paginated alert history for dashboard.
 */
export async function getAlertHistory({ type, status, userId, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];

  if (type) {
    params.push(type);
    conditions.push(`ah.alert_type = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`ah.status = $${params.length}`);
  }
  if (userId) {
    params.push(userId);
    conditions.push(`ah.user_id = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const [dataR, countR] = await Promise.all([
    pool.query(
      `SELECT ah.*, u.name AS user_name, u.phone_number
       FROM alert_history ah
       JOIN users u ON ah.user_id = u.id
       ${where}
       ORDER BY ah.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*) AS total FROM alert_history ah ${where}`,
      params.slice(0, conditions.length)
    ),
  ]);

  return {
    rows: dataR.rows,
    total: parseInt(countR.rows[0].total),
  };
}

/**
 * Get alert stats for dashboard.
 */
export async function getAlertStats() {
  const [totalR, byTypeR, byStatusR, weeklyR] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total FROM alert_history`),
    pool.query(
      `SELECT alert_type, COUNT(*) AS count
       FROM alert_history
       GROUP BY alert_type
       ORDER BY count DESC`
    ),
    pool.query(
      `SELECT status, COUNT(*) AS count
       FROM alert_history
       GROUP BY status
       ORDER BY count DESC`
    ),
    pool.query(
      `SELECT
         date_trunc('day', created_at)::date AS date,
         COUNT(*) AS count,
         COUNT(*) FILTER (WHERE status = 'sent') AS sent,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed
       FROM alert_history
       WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
       GROUP BY date
       ORDER BY date`
    ),
  ]);

  const total = parseInt(totalR.rows[0].total);
  const sentCount = byStatusR.rows.find(r => r.status === 'sent');
  const failedCount = byStatusR.rows.find(r => r.status === 'failed');

  return {
    total,
    byType: byTypeR.rows.map(r => ({ type: r.alert_type, count: parseInt(r.count) })),
    byStatus: byStatusR.rows.map(r => ({ status: r.status, count: parseInt(r.count) })),
    deliveryRate: total > 0
      ? Math.round(((parseInt(sentCount?.count || 0)) / total) * 1000) / 10
      : 0,
    weeklyTrend: weeklyR.rows.map(r => ({
      date: r.date,
      count: parseInt(r.count),
      sent: parseInt(r.sent),
      failed: parseInt(r.failed),
    })),
  };
}
