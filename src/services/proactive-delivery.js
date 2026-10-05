/**
 * Entrega de mensajes PROACTIVOS (los que el bot manda sin que el usuario haya
 * escrito): resúmenes, alertas, recordatorios, avisos de prueba. Fuente única
 * de "¿a quién se le puede mandar y cómo?" — la usa alert.service para TODO
 * envío (auditoría oct 2026, causa 12).
 *
 *  - getProactiveBlockReason: cuenta borrada o suspendida, usuario de prueba
 *    (testbot_*), plan sin la feature, prueba vencida para lo no esencial
 *    (CRN-6, CRN-8, CRN-9, CRN-11). Antes cada tick filtraba distinto y casi
 *    ninguno filtraba.
 *  - isOutsideWhatsAppWindow + deferMessage: fuera de la ventana de 24 h de
 *    WhatsApp el mensaje NO se manda; se guarda y se entrega cuando el usuario
 *    vuelve a escribir (decisión de producto, 4 oct 2026 — CRN-2).
 *  - takeDeferredMessages: lo llama el pipeline al recibir un mensaje.
 */
import { pool } from '../config/db.js';

/** Lo que el usuario PIDIÓ o necesita para operar su cuenta: pasa aunque la prueba esté vencida. */
const ESSENTIAL_TYPES = new Set([
  'reminder', 'task_reminder', 'trial_drip', 'trial_expiring', 'trial_expired',
  'subscription', 'payment', 'limit_hit', 'account',
]);

/** Feature del plan que habilita cada tipo de alerta (las demás no dependen del plan). */
const TYPE_FEATURE = {
  weather: 'weather',
  low_stock: 'stock',
  monitoring_reminder: 'agronomy',
  pest_escalation: 'agronomy',
  phenology: 'agronomy',
  missing_hectares: 'fields',
};

/**
 * Tipos que pierden sentido si llegan tarde: fuera de la ventana no se
 * difieren, se descartan con log (una alerta de helada de ayer confunde).
 */
const NOT_DEFERRABLE = new Set(['weather', 'flow_reminder']);

/** Cuánto vive un mensaje diferido esperando que el usuario escriba. */
const DEFER_TTL_DAYS = 7;

export const WHATSAPP_WINDOW_HOURS = 24;

/**
 * Motivo para NO mandar un proactivo a este usuario, o null si se puede.
 * @returns {Promise<string|null>}
 */
export async function getProactiveBlockReason(userId, alertType) {
  const { rows } = await pool.query(
    `SELECT u.deleted_at, u.status, u.phone_number FROM users u WHERE u.id = $1`,
    [userId]
  );
  const u = rows[0];
  if (!u) return 'usuario inexistente';
  if (u.deleted_at) return 'cuenta borrada';
  if (u.status === 'suspended' || u.status === 'disabled') return `cuenta ${u.status}`;
  if (u.phone_number && String(u.phone_number).startsWith('testbot_')) return 'usuario de prueba';
  if (ESSENTIAL_TYPES.has(alertType)) return null;

  try {
    const { getUserAccessMode } = await import('./access-gate.service.js');
    if ((await getUserAccessMode(Number(userId))) === 'trial_expired_readonly') return 'prueba vencida';
  } catch { /* fail-open: un error del gate no corta avisos */ }

  const feature = TYPE_FEATURE[alertType];
  if (feature) {
    try {
      const { FeatureGate } = await import('../domain/billing/feature-gate.js');
      if (!(await new FeatureGate().hasFeature(userId, feature))) return `plan sin "${feature}"`;
    } catch { /* fail-open */ }
  }
  return null;
}

/**
 * ¿El último mensaje del usuario es de hace más de 24 h (o nunca escribió)?
 * La ventana la abre lo que manda el USUARIO; lo que manda el bot no cuenta.
 */
export async function isOutsideWhatsAppWindow(userId) {
  const { rows } = await pool.query(
    // Solo lo que escribió por WHATSAPP: un mensaje por Telegram o el test-bot
    // no abre la ventana de WhatsApp.
    `SELECT MAX(created_at) AS last_in FROM conversation_logs
      WHERE user_id = $1 AND COALESCE(direction, 'inbound') = 'inbound'
        AND COALESCE(channel, 'whatsapp') = 'whatsapp'`,
    [userId]
  );
  const last = rows[0]?.last_in;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > WHATSAPP_WINDOW_HOURS * 3600_000;
}

/**
 * Guarda el mensaje para entregarlo cuando el usuario escriba. Devuelve false
 * si el tipo no se difiere (llegaría tarde y sin sentido).
 */
export async function deferMessage(userId, alertType, message, alertHistoryId = null) {
  if (NOT_DEFERRABLE.has(alertType)) return false;
  await pool.query(
    `INSERT INTO deferred_messages (user_id, alert_type, message, alert_history_id, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)`,
    [userId, alertType, message, alertHistoryId, String(DEFER_TTL_DAYS)]
  );
  return true;
}

/**
 * Mensajes diferidos vigentes del usuario, marcados como entregados en la
 * misma consulta (dos mensajes simultáneos no los entregan dos veces). Los
 * vencidos se descartan sin entregar.
 * @returns {Promise<Array<{ alert_type: string, message: string, created_at: Date }>>}
 */
export async function takeDeferredMessages(userId) {
  const { rows } = await pool.query(
    `UPDATE deferred_messages SET delivered_at = NOW()
      WHERE id IN (
        SELECT id FROM deferred_messages
         WHERE user_id = $1 AND delivered_at IS NULL AND expires_at > NOW()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
      )
      RETURNING alert_type, message, created_at, alert_history_id`,
    [userId]
  );
  if (rows.length > 0) {
    const ids = rows.map(r => r.alert_history_id).filter(Boolean);
    if (ids.length > 0) {
      await pool.query(
        `UPDATE alert_history SET status = 'sent', delivered_at = NOW() WHERE id = ANY($1::int[])`,
        [ids]
      );
    }
    console.log(`[proactive] ${rows.length} mensaje(s) diferido(s) entregado(s) a user ${userId}`);
  }
  return rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}
