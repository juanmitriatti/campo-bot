// "¿Este usuario puede usar el bot?" para el panel de admin (detalle de usuario).
// Cada chequeo usa la MISMA regla que el camino real, no una copia: el gate de
// canal del webhook (`findVerifiedByPhone`), el bloqueo de cuenta
// (`isAccountBlocked`), el modo de acceso (`getUserAccessMode`) y la ventana de
// 24 h de los proactivos (`lastWhatsAppInboundAt`). Si el panel dijera "sí" y el
// bot "no", el panel no serviría.
import { pool } from '../config/db.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { isAccountBlocked } from '../domain/auth/auth.types.js';
import { getUserAccessMode } from './access-gate.service.js';
import { lastWhatsAppInboundAt, WHATSAPP_WINDOW_HOURS } from './proactive-delivery.js';
import { getSettingBool } from './settings.service.js';
import { normalizePhone, isTelegramPlaceholder, formatPhoneAR } from '../utils/phone.js';

/** ok: true = bien, false = impide usar el bot, null = dato informativo. */
export interface BotAccessCheck {
  key: string;
  label: string;
  ok: boolean | null;
  detail: string;
}

export type BotAccessVerdict = 'puede' | 'solo_lectura' | 'no_puede';

export interface BotAccessReport {
  userId: number;
  verdict: BotAccessVerdict;
  summary: string;
  checks: BotAccessCheck[];
  checkedAt: string;
}

const fmt = (d: Date | string | null | undefined): string =>
  d ? new Date(d).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' }) : '';

export async function getBotAccessReport(userId: number): Promise<BotAccessReport | null> {
  const { rows } = await pool.query(
    `SELECT u.id, u.status, u.deleted_at, u.purged_at, u.phone_number, u.whatsapp_verified_at,
            u.telegram_id, u.telegram_verified_at, p.name AS plan_name
       FROM users u LEFT JOIN plans p ON p.id = u.plan_id
      WHERE u.id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u) return null;

  const checks: BotAccessCheck[] = [];

  // 1. Cuenta
  const blocked = !!u.deleted_at || !!u.purged_at || isAccountBlocked(u.status);
  checks.push({
    key: 'account', label: 'Cuenta activa', ok: !blocked,
    detail: u.deleted_at ? `Dada de baja el ${fmt(u.deleted_at)}` : isAccountBlocked(u.status) ? `Estado «${u.status}»: el bot no la atiende` : 'Activa',
  });

  // 2. Número de WhatsApp
  const raw = u.phone_number ? String(u.phone_number) : '';
  const fake = !raw || raw.startsWith('testbot_') || isTelegramPlaceholder(raw);
  const canonical = fake ? null : normalizePhone(raw);
  checks.push({
    key: 'phone', label: 'Número de WhatsApp', ok: !!canonical,
    detail: !raw ? 'No tiene número cargado'
      : raw.startsWith('testbot_') ? 'Cuenta del canal de pruebas, no de WhatsApp'
      : fake ? 'Solo tiene Telegram'
      : canonical ? formatPhoneAR(canonical)
      : 'El número cargado no es un celular argentino válido',
  });

  // 3. Verificación (el gate del webhook) + 4. que el webhook llegue a ESTA cuenta
  const required = (await getSettingBool('REQUIRE_VERIFIED_CHANNEL')) === true;
  const verified = !!u.whatsapp_verified_at;
  checks.push({
    key: 'verified', label: 'WhatsApp verificado', ok: verified || (!required && !!canonical),
    detail: verified ? `Verificado el ${fmt(u.whatsapp_verified_at)}`
      : required ? 'Sin verificar: el bot le pide que cree la cuenta y vincule WhatsApp'
      : 'Sin verificar (hoy no se exige)',
  });
  if (canonical) {
    const owner = await new UserRepository().findVerifiedByPhone(canonical);
    const ownerId = owner ? Number(owner.id) : null;
    checks.push({
      key: 'routing', label: 'Sus mensajes llegan a esta cuenta', ok: ownerId === userId || (!ownerId && !required),
      detail: ownerId === userId ? 'El bot lo reconoce por su número'
        : ownerId ? `El número está verificado en otra cuenta (#${ownerId}): el bot le contesta como esa`
        : required ? 'Ninguna cuenta verificada con ese número: el bot no lo reconoce'
        : 'Se reconoce por el número (la verificación no se exige)',
    });
  }

  // 5. Acceso (prueba / suscripción)
  const mode = await getUserAccessMode(userId);
  const { rows: subs } = await pool.query(
    `SELECT status, trial_ends_at, current_period_end FROM subscriptions
      WHERE user_id = $1 AND status <> 'pending'
      ORDER BY (status IN ('trial','active','past_due')) DESC, created_at DESC, id DESC LIMIT 1`,
    [userId],
  );
  const sub = subs[0];
  const subDetail = !sub ? 'Sin suscripción registrada: acceso completo sin vencimiento'
    : sub.status === 'trial' ? `Prueba ${new Date(sub.trial_ends_at) > new Date() ? 'hasta' : 'vencida el'} ${fmt(sub.trial_ends_at)}`
    : sub.status === 'active' ? `Suscripción activa${sub.current_period_end ? ` hasta ${fmt(sub.current_period_end)}` : ''}`
    : `Suscripción «${sub.status}»`;
  checks.push({
    key: 'access', label: 'Puede cargar datos', ok: mode === 'full',
    detail: mode === 'full' ? subDetail : `${subDetail}. Solo lectura: puede consultar, no cargar`,
  });

  // 6. Plan (informativo)
  checks.push({ key: 'plan', label: 'Plan', ok: null, detail: u.plan_name ?? 'Sin plan asignado' });

  // 7. Ventana de 24 h (informativo)
  const lastIn = await lastWhatsAppInboundAt(userId);
  const inWindow = !!lastIn && Date.now() - new Date(lastIn).getTime() <= WHATSAPP_WINDOW_HOURS * 3600_000;
  checks.push({
    key: 'window', label: 'El bot le puede escribir primero', ok: null,
    detail: !lastIn ? 'Nunca escribió por WhatsApp: el bot no puede iniciar la conversación'
      : inWindow ? `Sí, escribió el ${fmt(lastIn)} (dentro de las 24 h)`
      : `No, tiene que escribir él primero (último mensaje: ${fmt(lastIn)})`,
  });

  // 8. Telegram (informativo)
  checks.push({
    key: 'telegram', label: 'Telegram', ok: null,
    detail: u.telegram_verified_at ? `Vinculado el ${fmt(u.telegram_verified_at)}` : u.telegram_id ? 'Con chat, sin verificar' : 'No vinculado',
  });

  const blocking = checks.filter(c => c.ok === false && c.key !== 'access');
  const verdict: BotAccessVerdict = blocking.length ? 'no_puede' : mode === 'full' ? 'puede' : 'solo_lectura';
  const summary = verdict === 'puede' ? 'Puede usar el bot por WhatsApp'
    : verdict === 'solo_lectura' ? 'Puede escribirle al bot, pero solo consultar'
    : `No puede usar el bot: ${blocking.map(c => c.label.toLowerCase()).join(', ')}`;

  return { userId, verdict, summary, checks, checkedAt: new Date().toISOString() };
}
