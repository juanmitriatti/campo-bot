import crypto from 'crypto';
import { pool, withTransaction } from '../../config/db.js';
import { normalizePhone } from '../../utils/phone.js';
import { sendMessage as sendWhatsAppMessage } from '../../services/whatsapp.js';
import { getSetting, getSettingNumber } from '../../services/settings.service.js';
import type { UserId } from '../../types/index.js';
import { getAppName } from '../../utils/brand.js';
import { buildBotWaLink } from '../../utils/whatsapp-link.js';
import { whatsappVerifyText } from '../../utils/lexicon.js';

const DEFAULT_OTP_TTL_MIN = 10;
const DEFAULT_OTP_MAX_ATTEMPTS = 5;
const DEFAULT_TELEGRAM_TTL_MIN = 60 * 24; // 24h for deep-link tokens
// El código que se le manda AL bot vive más: el usuario tiene que cambiar de
// app (o de teléfono, si abrió la web en la compu) y mandarlo.
const MIN_INBOUND_TTL_MIN = 30;

export interface VerificationStatus {
  whatsapp_verified: boolean;
  telegram_verified: boolean;
  phone_number: string | null;
  telegram_id: string | null;
}

export interface StartWhatsAppResult {
  expires_at: string;
  ttl_minutes: number;
  /**
   * inbound = el usuario le manda el código al bot (`wa_link`/`wa_text`);
   * outbound = el bot le mandó el código y el usuario lo escribe en la web.
   * Inbound siempre que haya WHATSAPP_BOT_NUMBER: el envío del bot no le llega
   * a quien nunca le escribió (ventana de 24 h de Meta, error 131047).
   */
  mode: 'inbound' | 'outbound';
  wa_link?: string;
  wa_text?: string;
  code?: string;
}

export interface StartTelegramResult {
  deep_link: string;
  token: string;
  expires_at: string;
}

export class VerificationError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'VerificationError';
  }
}

// La normalización vive en `src/utils/phone.ts` (fuente única). La copia local
// que había acá guardaba `+54...` y encima NO insertaba el 9 de celular, así
// que el número que quedaba en `users.phone_number` no era el que manda Meta y
// el webhook no volvía a encontrar a la persona nunca más.

function generateOtp(): string {
  // 6-digit numeric, zero-padded. Crypto-secure.
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

function generateLinkToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * CTA-11: la prueba gratis es una por NÚMERO, no por cuenta. Desvincular el
 * WhatsApp y abrir otra cuenta daba 14 días más, sin fin. Si este número ya
 * se verificó en otra cuenta que tuvo suscripción (prueba o pago) y esta
 * cuenta está en su prueba, la prueba se da por terminada. Una suscripción
 * paga no se toca.
 */
async function endRecycledTrial(userId: number, phone: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT 1 FROM channel_verifications cv
      WHERE cv.channel = 'whatsapp' AND cv.target = $1 AND cv.user_id <> $2 AND cv.verified_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = cv.user_id)
      LIMIT 1`,
    [phone, userId],
  );
  if (rows.length === 0) return;
  const ended = await pool.query(
    `UPDATE subscriptions SET status = 'expired', trial_ends_at = LEAST(trial_ends_at, NOW()), updated_at = NOW()
      WHERE user_id = $1 AND status = 'trial' AND provider = 'trial'
      RETURNING id`,
    [userId],
  );
  if (ended.rows.length > 0) {
    // Mismo destino que una prueba vencida por el barrido nocturno: plan free.
    await pool.query(`UPDATE users SET plan_id = (SELECT id FROM plans WHERE name = 'free') WHERE id = $1`, [userId]);
    console.log(`[TRIAL] user=${userId}: el número ya usó una prueba en otra cuenta — prueba terminada`);
  }
}

/**
 * CTA-7: el número (o el Telegram) que se quiere vincular puede estar ya en
 * una cuenta que el bot creó sola cuando esa persona escribió por el chat, sin
 * verificar. El UPDATE chocaba con la UNIQUE, daba 500 y el código quedaba
 * consumido. Si esa cuenta está VACÍA se le saca el canal (era solo el rastro
 * del primer mensaje); si tiene datos, no se mezclan cuentas a ciegas: 409 con
 * explicación y el código sigue sirviendo. Llamar dentro de la transacción.
 */
async function releaseChannelFromChatAccount(
  column: 'phone_number' | 'telegram_id',
  value: string,
  targetUserId: number,
): Promise<void> {
  const match = column === 'phone_number'
    ? `(phone_number = $1 OR canonical_phone_ar(phone_number) = $1)`
    : `telegram_id::text = $1::text`;
  const { rows } = await pool.query(
    `SELECT u.id,
            (EXISTS (SELECT 1 FROM fields f WHERE f.user_id = u.id)
             OR EXISTS (SELECT 1 FROM field_members fm WHERE fm.user_id = u.id)
             OR EXISTS (SELECT 1 FROM expenses e WHERE e.user_id = u.id)
             OR EXISTS (SELECT 1 FROM incomes i WHERE i.user_id = u.id)
             OR EXISTS (SELECT 1 FROM domain_events d WHERE d.user_id = u.id)
             OR EXISTS (SELECT 1 FROM rainfall r WHERE r.user_id = u.id)) AS has_data
       FROM users u
      WHERE ${match} AND u.id <> $2`,
    [value, targetUserId],
  );
  for (const r of rows) {
    if (r.has_data) {
      console.log(`[VERIFY] ${column} de user=${targetUserId} lo usa la cuenta de chat ${r.id} con datos — no se vincula`);
      throw new VerificationError(
        409,
        'CHANNEL_HAS_CHAT_DATA',
        column === 'phone_number'
          ? 'Ese número ya tiene datos cargados desde el chat en otra cuenta. Escribinos para unir las dos cuentas; no perdés nada.'
          : 'Ese Telegram ya tiene datos cargados desde el chat en otra cuenta. Escribinos para unir las dos cuentas; no perdés nada.',
      );
    }
    await pool.query(`UPDATE users SET ${column} = NULL WHERE id = $1`, [r.id]);
    console.log(`[VERIFY] ${column} liberado de la cuenta de chat vacía ${r.id} para user=${targetUserId}`);
  }
}

export class ChannelVerificationService {
  /**
   * Start WhatsApp verification: generate OTP, persist row, send via WhatsApp API.
   */
  async startWhatsApp(userId: UserId, rawPhone: string): Promise<StartWhatsAppResult> {
    if (!rawPhone || rawPhone.trim().length < 6) {
      throw new VerificationError(400, 'INVALID_PHONE', 'El número de teléfono es obligatorio.');
    }
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      throw new VerificationError(400, 'INVALID_PHONE', 'Número inválido. Usá el formato +54 9 11 1234 5678.');
    }

    // Reject if another VERIFIED user already owns this phone
    const conflict = await pool.query(
      `SELECT id FROM users
       WHERE (phone_number = $1 OR canonical_phone_ar(phone_number) = $1)
         AND id <> $2 AND whatsapp_verified_at IS NOT NULL`,
      [phone, userId]
    );
    if (conflict.rows.length > 0) {
      throw new VerificationError(
        409,
        'PHONE_TAKEN',
        'Este número ya está vinculado a otra cuenta. Si es tuya, iniciá sesión con esa cuenta.'
      );
    }

    const otpTtl = (await getSettingNumber('OTP_TTL_MINUTES')) ?? DEFAULT_OTP_TTL_MIN;
    const code = generateOtp();
    const waText = whatsappVerifyText(code);
    const waLink = await buildBotWaLink(waText);
    const direction: 'inbound' | 'outbound' = waLink ? 'inbound' : 'outbound';
    const ttlMin = direction === 'inbound' ? Math.max(otpTtl, MIN_INBOUND_TTL_MIN) : otpTtl;
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);

    // Invalidate previous pending OTPs for this user+channel
    await pool.query(
      `UPDATE channel_verifications
       SET verified_at = NOW(), attempts = attempts + 100
       WHERE user_id = $1 AND channel = 'whatsapp' AND verified_at IS NULL`,
      [userId]
    );

    await pool.query(
      `INSERT INTO channel_verifications (user_id, channel, code, target, expires_at, direction)
       VALUES ($1, 'whatsapp', $2, $3, $4, $5)`,
      [userId, code, phone, expiresAt, direction]
    );

    if (direction === 'inbound') {
      console.log(`[VERIFY] whatsapp inbound user=${userId}: código para mandar al bot desde ${phone}`);
      return { expires_at: expiresAt.toISOString(), ttl_minutes: ttlMin, mode: 'inbound', wa_link: waLink!, wa_text: waText, code };
    }

    // Sin número de bot configurado: el camino viejo. Solo le llega a quien le
    // escribió al bot en las últimas 24 h; el rechazo de Meta llega después por
    // el webhook de estados (`[INTERCEPT] entrega FALLIDA`), no acá.
    console.warn(`[VERIFY] [INTERCEPT] WHATSAPP_BOT_NUMBER vacío: el código va saliente a ${phone} y solo llega si escribió en las últimas 24 h`);

    // `phone` ya viene canónico (`549...`, sin `+`), que es justo lo que
    // espera la Cloud API.
    const waNumber = phone;
    const message =
      `🔐 *Tu código de ${await getAppName()}*\n\n` +
      `\`${code}\`\n\n` +
      `Pegalo en la app para vincular este WhatsApp a tu cuenta. ` +
      `Vence en ${ttlMin} minutos.`;

    try {
      await sendWhatsAppMessage(waNumber, message);
    } catch (err) {
      // Don't leak the OTP in errors. Surface a generic problem.
      throw new VerificationError(
        502,
        'SEND_FAILED',
        'No pude enviar el código por WhatsApp. Verificá el número y volvé a intentar.'
      );
    }

    return {
      expires_at: expiresAt.toISOString(),
      ttl_minutes: ttlMin,
      mode: 'outbound',
    };
  }

  /**
   * Confirm WhatsApp OTP. On success, set phone + whatsapp_verified_at on the user.
   */
  async confirmWhatsApp(userId: UserId, rawCode: string): Promise<VerificationStatus> {
    const code = (rawCode || '').trim();
    if (!/^\d{6}$/.test(code)) {
      throw new VerificationError(400, 'INVALID_CODE', 'El código debe tener 6 dígitos.');
    }

    const maxAttempts = (await getSettingNumber('OTP_MAX_ATTEMPTS')) ?? DEFAULT_OTP_MAX_ATTEMPTS;

    const { rows } = await pool.query(
      `SELECT id, code, target, attempts, expires_at, direction
       FROM channel_verifications
       WHERE user_id = $1 AND channel = 'whatsapp' AND verified_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    if (rows.length === 0) {
      throw new VerificationError(404, 'NO_PENDING', 'No hay un código pendiente. Pediste uno?');
    }
    const row = rows[0];

    // Un código inbound está a la vista en la pantalla: escribirlo acá no prueba
    // que el número sea tuyo. Solo vale mandándoselo al bot desde ese WhatsApp.
    if (row.direction === 'inbound') {
      throw new VerificationError(409, 'SEND_TO_BOT', 'Este código no se escribe acá: mandáselo al bot por WhatsApp desde tu número.');
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new VerificationError(410, 'EXPIRED', 'El código expiró. Pedí uno nuevo.');
    }

    if (row.attempts >= maxAttempts) {
      throw new VerificationError(429, 'TOO_MANY_ATTEMPTS', 'Demasiados intentos. Pedí un código nuevo.');
    }

    if (row.code !== code) {
      await pool.query(
        `UPDATE channel_verifications SET attempts = attempts + 1 WHERE id = $1`,
        [row.id]
      );
      throw new VerificationError(401, 'WRONG_CODE', 'Código incorrecto. Volvé a intentar.');
    }

    await this.linkPhone(row.id, Number(userId), row.target);
    return this.getStatus(userId);
  }

  /**
   * Canjea "verificar 123456" que llegó AL bot (link wa.me de Mi cuenta). El
   * número que se vincula es el que MANDÓ el mensaje — Meta firma el webhook
   * (`WHATSAPP_APP_SECRET`) — y tiene que ser el que el usuario puso en la web:
   * el código está a la vista en esa pantalla, así que sin ese cruce cualquiera
   * con un código ajeno colgaría su número de otra cuenta.
   */
  async redeemWhatsAppInbound(
    rawFromPhone: string,
    rawCode: string,
  ): Promise<{ user_id: number; already_linked: boolean }> {
    const code = (rawCode || '').trim();
    const phone = normalizePhone(rawFromPhone);
    if (!/^\d{6}$/.test(code) || !phone) {
      throw new VerificationError(400, 'INVALID_CODE', 'El código tiene que ser de 6 dígitos.');
    }

    const { rows } = await pool.query(
      `SELECT id, user_id, target, expires_at
         FROM channel_verifications
        WHERE channel = 'whatsapp' AND direction = 'inbound' AND code = $1 AND verified_at IS NULL
        ORDER BY id DESC`,
      [code],
    );
    const row = rows.find((r) => r.target === phone);
    if (!row) {
      // El mismo mensaje mandado dos veces: el primero ya vinculó. Éxito idempotente.
      const done = await pool.query(
        `SELECT cv.user_id FROM channel_verifications cv JOIN users u ON u.id = cv.user_id
          WHERE cv.channel = 'whatsapp' AND cv.direction = 'inbound' AND cv.code = $1 AND cv.target = $2
            AND cv.verified_at IS NOT NULL AND cv.attempts < 100
            AND u.phone_number = $2 AND u.whatsapp_verified_at IS NOT NULL
          ORDER BY cv.id DESC LIMIT 1`,
        [code, phone],
      );
      if (done.rows.length > 0) return { user_id: Number(done.rows[0].user_id), already_linked: true };
      if (rows.length > 0) {
        console.log(`[VERIFY] [INTERCEPT] código inbound mandado desde ${phone}, pedido para otro número — no se vincula`);
        throw new VerificationError(
          409,
          'OTHER_PHONE',
          'Ese código se pidió para otro número. Mandalo desde el WhatsApp que pusiste en la web, o cambiá el número ahí y pedí un código nuevo.',
        );
      }
      console.log(`[VERIFY] [INTERCEPT] código inbound desde ${phone} sin verificación pendiente`);
      throw new VerificationError(404, 'NO_PENDING', 'Ese código no es válido o ya se usó. Pedí uno nuevo desde la web, en Mi cuenta → Vincular WhatsApp.');
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new VerificationError(410, 'EXPIRED', 'Ese código venció. Pedí uno nuevo desde la web, en Mi cuenta → Vincular WhatsApp.');
    }

    await this.linkPhone(row.id, Number(row.user_id), phone);
    console.log(`[VERIFY] whatsapp vinculado por mensaje entrante: user=${row.user_id} phone=${phone}`);
    return { user_id: Number(row.user_id), already_linked: false };
  }

  /** Vincula el número a la cuenta y consume la verificación, todo junto. */
  private async linkPhone(verificationId: number, userId: number, phone: string): Promise<void> {
    // Race-safe: re-check phone is not taken by another verified user
    const conflict = await pool.query(
      `SELECT id FROM users
       WHERE (phone_number = $1 OR canonical_phone_ar(phone_number) = $1)
         AND id <> $2 AND whatsapp_verified_at IS NOT NULL`,
      [phone, userId]
    );
    if (conflict.rows.length > 0) {
      throw new VerificationError(
        409,
        'PHONE_TAKEN',
        'Este número ya está vinculado a otra cuenta.'
      );
    }

    // Todo junto (CTA-7): si algo falla, el código NO queda consumido.
    await withTransaction(async () => {
      await releaseChannelFromChatAccount('phone_number', phone, userId);
      await pool.query(
        `UPDATE channel_verifications SET verified_at = NOW() WHERE id = $1`,
        [verificationId]
      );
      await pool.query(
        `UPDATE users SET phone_number = $1, whatsapp_verified_at = NOW() WHERE id = $2`,
        [phone, userId]
      );
      await endRecycledTrial(userId, phone);
    });
  }

  /**
   * Start Telegram verification: generate deep-link token + URL.
   */
  async startTelegramLink(userId: UserId): Promise<StartTelegramResult> {
    const username = (await getSetting('TELEGRAM_BOT_USERNAME'))?.trim();
    if (!username) {
      throw new VerificationError(
        503,
        'TELEGRAM_NOT_CONFIGURED',
        'Telegram no está configurado en este momento. Contactá al administrador.'
      );
    }

    const ttlMin = (await getSettingNumber('TELEGRAM_LINK_TTL_MINUTES')) ?? DEFAULT_TELEGRAM_TTL_MIN;
    const token = generateLinkToken();
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);

    // Invalidate previous pending tokens
    await pool.query(
      `UPDATE channel_verifications
       SET verified_at = NOW(), attempts = attempts + 100
       WHERE user_id = $1 AND channel = 'telegram' AND verified_at IS NULL`,
      [userId]
    );

    await pool.query(
      `INSERT INTO channel_verifications (user_id, channel, code, expires_at)
       VALUES ($1, 'telegram', $2, $3)`,
      [userId, token, expiresAt]
    );

    return {
      deep_link: `https://t.me/${username}?start=verify_${token}`,
      token,
      expires_at: expiresAt.toISOString(),
    };
  }

  /**
   * Redeem a Telegram deep-link token (called by the bot when it receives
   * `/start verify_<token>`). Links the chat to the web user.
   */
  async redeemTelegramToken(
    rawToken: string,
    telegramChatId: string,
    telegramFirstName?: string | null
  ): Promise<{ user_id: number; already_linked: boolean }> {
    const token = (rawToken || '').trim();
    if (!token || token.length < 16) {
      throw new VerificationError(400, 'INVALID_TOKEN', 'Token inválido.');
    }

    const { rows } = await pool.query(
      `SELECT id, user_id, expires_at
       FROM channel_verifications
       WHERE channel = 'telegram' AND code = $1 AND verified_at IS NULL
       LIMIT 1`,
      [token]
    );
    if (rows.length === 0) {
      throw new VerificationError(404, 'NO_PENDING', 'Este link no es válido o ya fue usado.');
    }
    const row = rows[0];
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new VerificationError(410, 'EXPIRED', 'Este link expiró. Pedí uno nuevo desde la app.');
    }

    // Check that this Telegram chat isn't already linked to a different verified user
    const existing = await pool.query(
      `SELECT id FROM users
       WHERE telegram_id = $1 AND id <> $2 AND telegram_verified_at IS NOT NULL`,
      [telegramChatId, row.user_id]
    );
    if (existing.rows.length > 0) {
      throw new VerificationError(
        409,
        'TELEGRAM_TAKEN',
        'Este Telegram ya está vinculado a otra cuenta.'
      );
    }

    // Already linked to this same user? idempotent success.
    const same = await pool.query(
      `SELECT telegram_verified_at FROM users WHERE id = $1`,
      [row.user_id]
    );
    const alreadyLinked = same.rows[0]?.telegram_verified_at != null;

    await withTransaction(async () => {
      await releaseChannelFromChatAccount('telegram_id', String(telegramChatId), Number(row.user_id));
      await pool.query(
        `UPDATE channel_verifications SET verified_at = NOW() WHERE id = $1`,
        [row.id]
      );
      await pool.query(
        `UPDATE users
         SET telegram_id = $1,
             telegram_verified_at = NOW(),
             name = COALESCE(name, $2)
         WHERE id = $3`,
        [telegramChatId, telegramFirstName ?? null, row.user_id]
      );
    });

    return { user_id: row.user_id, already_linked: alreadyLinked };
  }

  /**
   * Unlink a channel from the current user.
   */
  async unlinkWhatsApp(userId: UserId): Promise<VerificationStatus> {
    await pool.query(
      `UPDATE users SET phone_number = NULL, whatsapp_verified_at = NULL WHERE id = $1`,
      [userId]
    );
    return this.getStatus(userId);
  }

  async unlinkTelegram(userId: UserId): Promise<VerificationStatus> {
    await pool.query(
      `UPDATE users SET telegram_id = NULL, telegram_verified_at = NULL WHERE id = $1`,
      [userId]
    );
    return this.getStatus(userId);
  }

  async getStatus(userId: UserId): Promise<VerificationStatus> {
    const { rows } = await pool.query(
      `SELECT phone_number, telegram_id, whatsapp_verified_at, telegram_verified_at
       FROM users WHERE id = $1`,
      [userId]
    );
    if (rows.length === 0) {
      throw new VerificationError(404, 'USER_NOT_FOUND', 'Usuario no encontrado.');
    }
    const r = rows[0];
    return {
      whatsapp_verified: r.whatsapp_verified_at != null,
      telegram_verified: r.telegram_verified_at != null,
      phone_number: r.phone_number ?? null,
      telegram_id: r.telegram_id ?? null,
    };
  }
}
