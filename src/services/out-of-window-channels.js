/**
 * Qué hacer con un mensaje proactivo que NO puede salir por WhatsApp porque el
 * usuario no escribió en las últimas 24 h (proactive-delivery.js lo difiere).
 * Dos canales complementarios, independientes y best-effort:
 *
 *  1. MAIL (PROACTIVE_EMAIL_FALLBACK_ENABLED): el contenido del mensaje va por
 *     mail a la casilla VERIFICADA del usuario. Llega ya, sin depender de Meta.
 *     El mensaje igual queda diferido: si después escribe por WhatsApp, lo
 *     recibe también ahí (WhatsApp es el canal principal; el mail puede caer
 *     en spam).
 *  2. PLANTILLA DE WHATSAPP (WHATSAPP_REENGAGE_TEMPLATE): un aviso aprobado por
 *     Meta ("tenés N novedades, respondé para verlas"). Cuando el usuario
 *     contesta se abre la ventana y el pipeline le entrega lo diferido. Una
 *     sola por usuario cada 24 h, y solo si quedó algo diferido para entregar.
 *     Sin nombre de plantilla cargado, no hace nada (y lo loguea).
 *
 * Todo skip se loguea con [OUT_OF_WINDOW] (invariante 1). Nada de esto puede
 * romper el envío que lo llamó: los errores se tragan y se loguean.
 */
import { pool } from '../config/db.js';
import { getSetting, getSettingBool } from './settings.service.js';
import { sendTemplate } from './whatsapp.js';
import { sendEmail, wrapHtml } from './mailer.service.js';
import { getAppName } from '../utils/brand.js';
import { buildBotWaLink } from '../utils/whatsapp-link.js';
import { logError } from './error-logger.js';

/** Avisos atados a una conversación en curso: por mail no tienen sentido. */
const EMAIL_SKIP_TYPES = new Set(['flow_reminder', 'flow_timeout', 'flow_halflife']);

const REENGAGE_ALERT_TYPE = 'reengage_template';
const REENGAGE_WINDOW_HOURS = 24;

const SUBJECTS = {
  reminder: '⏰ Recordatorio',
  task_reminder: '⏰ Recordatorio',
  weekly_summary: '📊 Tu resumen de la semana',
  monthly_summary: '📊 Tu resumen del mes',
  weather: '🌦️ Alerta de clima',
  low_stock: '📦 Stock bajo',
  monitoring_reminder: '🔎 Recordatorio de monitoreo',
  pest_escalation: '🐛 Alerta de plagas',
  phenology: '🌱 Etapa del cultivo',
  missing_hectares: '📐 Faltan hectáreas de tus lotes',
};

function log(msg) {
  console.log(`[OUT_OF_WINDOW] ${msg}`);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Formato de WhatsApp (*negrita*, _cursiva_, saltos de línea) → HTML seguro. */
export function whatsappTextToHtml(text) {
  return escapeHtml(text)
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/gm, '$1<em>$2</em>')
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 12px;line-height:1.5;">${p.replace(/\n/g, '<br />')}</p>`)
    .join('');
}

/** Texto plano para la parte `text` del mail: sin los marcadores de WhatsApp. */
function whatsappTextToPlain(text) {
  return String(text).replace(/\*([^*\n]+)\*/g, '$1').replace(/(^|[\s(])_([^_\n]+)_/gm, '$1$2');
}

export function emailSubjectFor(alertType, appName) {
  if (SUBJECTS[alertType]) return SUBJECTS[alertType];
  if (String(alertType).startsWith('trial')) return `Tu prueba de ${appName}`;
  return `Novedades de tu campo en ${appName}`;
}

async function sendByEmail(userId, alertType, message) {
  if (EMAIL_SKIP_TYPES.has(alertType)) return 'skipped:tipo sin sentido por mail';
  if ((await getSettingBool('PROACTIVE_EMAIL_FALLBACK_ENABLED')) !== true) return 'skipped:apagado';

  const { rows } = await pool.query(
    `SELECT email, email_verified_at FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  const u = rows[0];
  if (!u?.email) return 'skipped:sin mail';
  if (!u.email_verified_at) return 'skipped:mail sin verificar';

  const appName = await getAppName();
  const waLink = await buildBotWaLink('hola');
  const subject = emailSubjectFor(alertType, appName);
  const footer = 'Te llegó por mail porque hace más de 24 h que no le escribís al bot por WhatsApp. '
    + 'Si le escribís, te llega todo por ahí.';
  const html = wrapHtml(
    subject,
    whatsappTextToHtml(message),
    waLink ?? undefined,
    waLink ? 'Abrir el chat con el bot' : undefined,
    appName,
    footer,
  );
  const text = `${whatsappTextToPlain(message)}\n\n${waLink ? `Abrir el chat con el bot: ${waLink}\n\n` : ''}${footer}`;

  const res = await sendEmail({ to: u.email, subject, html, text });
  return res.ok ? 'sent' : `failed:${res.reason ?? 'desconocido'}`;
}

/** Parámetros del cuerpo de la plantilla, en el orden que diga el setting. */
async function templateParams(userId) {
  const spec = String((await getSetting('WHATSAPP_REENGAGE_TEMPLATE_PARAMS')) ?? 'nombre,cantidad');
  const tokens = spec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT u.name,
            (SELECT COUNT(*) FROM deferred_messages d
              WHERE d.user_id = u.id AND d.delivered_at IS NULL AND d.expires_at > NOW())::int AS pending
       FROM users u WHERE u.id = $1`,
    [userId]
  );
  const name = String(rows[0]?.name ?? '').trim().split(/\s+/)[0] || 'productor';
  const pending = Math.max(1, rows[0]?.pending ?? 1);
  return tokens.map(t => (t === 'cantidad' ? String(pending) : name));
}

async function sendReengageTemplate(userId, phone) {
  const name = String((await getSetting('WHATSAPP_REENGAGE_TEMPLATE')) ?? '').trim();
  if (!name) return 'skipped:sin plantilla configurada';
  if (!phone || String(phone).startsWith('tg_') || String(phone).startsWith('testbot_')) return 'skipped:sin WhatsApp';

  const recent = await pool.query(
    `SELECT 1 FROM alert_history
      WHERE user_id = $1 AND alert_type = $2 AND status = 'sent'
        AND created_at > NOW() - $3::int * INTERVAL '1 hour'
      LIMIT 1`,
    [userId, REENGAGE_ALERT_TYPE, REENGAGE_WINDOW_HOURS]
  );
  if (recent.rows.length > 0) return 'skipped:ya se mandó una en las últimas 24 h';

  const lang = String((await getSetting('WHATSAPP_REENGAGE_TEMPLATE_LANG')) ?? '').trim() || 'es_AR';
  const params = await templateParams(userId);
  try {
    await sendTemplate(phone, name, lang, params);
  } catch (err) {
    await pool.query(
      `INSERT INTO alert_history (user_id, alert_type, message, payload, status)
       VALUES ($1, $2, $3, $4, 'failed')`,
      [userId, REENGAGE_ALERT_TYPE, `plantilla ${name}`, JSON.stringify({ error: String(err?.message ?? err).slice(0, 300) })]
    );
    return `failed:${String(err?.message ?? err).slice(0, 120)}`;
  }
  await pool.query(
    `INSERT INTO alert_history (user_id, alert_type, message, payload, status, delivered_at)
     VALUES ($1, $2, $3, $4, 'sent', NOW())`,
    [userId, REENGAGE_ALERT_TYPE, `plantilla ${name}`, JSON.stringify({ params })]
  );
  return 'sent';
}

/**
 * Lo llama alert.service cuando un mensaje quedó fuera de la ventana de 24 h.
 * @param {{ userId: number, phone: string|null, alertType: string, message: string, alertId: number, deferred: boolean }} args
 * @returns {Promise<{ email: string, template: string }>}
 */
export async function notifyOutsideWindow({ userId, phone, alertType, message, alertId, deferred }) {
  let email = 'skipped:error';
  let template = 'skipped:error';
  try {
    email = await sendByEmail(userId, alertType, message);
  } catch (err) {
    email = `failed:${String(err?.message ?? err).slice(0, 120)}`;
    logError('alerts', 'OUT_OF_WINDOW_EMAIL_ERROR', err, { userId, alertType, alertId });
  }
  try {
    // Sin nada diferido, contestar la plantilla no le entregaría nada.
    template = deferred ? await sendReengageTemplate(userId, phone) : 'skipped:no quedó nada diferido';
  } catch (err) {
    template = `failed:${String(err?.message ?? err).slice(0, 120)}`;
    logError('alerts', 'OUT_OF_WINDOW_TEMPLATE_ERROR', err, { userId, alertType, alertId });
  }
  log(`user ${userId} '${alertType}' (alert ${alertId}): mail=${email} plantilla=${template}`);
  try {
    await pool.query(
      `UPDATE alert_history
          SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('email', $2::text, 'template', $3::text)
        WHERE id = $1`,
      [alertId, email, template]
    );
  } catch { /* el historial es forense; no corta nada */ }
  return { email, template };
}
