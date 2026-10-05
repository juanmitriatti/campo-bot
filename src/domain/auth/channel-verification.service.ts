import crypto from 'crypto';
import { pool, withTransaction } from '../../config/db.js';
import { normalizePhone } from '../../utils/phone.js';
import { sendMessage as sendWhatsAppMessage } from '../../services/whatsapp.js';
import { getSetting, getSettingNumber } from '../../services/settings.service.js';
import type { UserId } from '../../types/index.js';

const DEFAULT_OTP_TTL_MIN = 10;
const DEFAULT_OTP_MAX_ATTEMPTS = 5;
const DEFAULT_TELEGRAM_TTL_MIN = 60 * 24; // 24h for deep-link tokens

export interface VerificationStatus {
  whatsapp_verified: boolean;
  telegram_verified: boolean;
  phone_number: string | null;
  telegram_id: string | null;
}

export interface StartWhatsAppResult {
  expires_at: string;
  ttl_minutes: number;
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

    const ttlMin = (await getSettingNumber('OTP_TTL_MINUTES')) ?? DEFAULT_OTP_TTL_MIN;
    const code = generateOtp();
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);

    // Invalidate previous pending OTPs for this user+channel
    await pool.query(
      `UPDATE channel_verifications
       SET verified_at = NOW(), attempts = attempts + 100
       WHERE user_id = $1 AND channel = 'whatsapp' AND verified_at IS NULL`,
      [userId]
    );

    await pool.query(
      `INSERT INTO channel_verifications (user_id, channel, code, target, expires_at)
       VALUES ($1, 'whatsapp', $2, $3, $4)`,
      [userId, code, phone, expiresAt]
    );

    // `phone` ya viene canónico (`549...`, sin `+`), que es justo lo que
    // espera la Cloud API.
    const waNumber = phone;
    const message =
      `🔐 *Tu código de Campo Bot*\n\n` +
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
      `SELECT id, code, target, attempts, expires_at
       FROM channel_verifications
       WHERE user_id = $1 AND channel = 'whatsapp' AND verified_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    if (rows.length === 0) {
      throw new VerificationError(404, 'NO_PENDING', 'No hay un código pendiente. Pediste uno?');
    }
    const row = rows[0];

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

    // Race-safe: re-check phone is not taken by another verified user
    const conflict = await pool.query(
      `SELECT id FROM users
       WHERE (phone_number = $1 OR canonical_phone_ar(phone_number) = $1)
         AND id <> $2 AND whatsapp_verified_at IS NOT NULL`,
      [row.target, userId]
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
      await releaseChannelFromChatAccount('phone_number', row.target, Number(userId));
      await pool.query(
        `UPDATE channel_verifications SET verified_at = NOW() WHERE id = $1`,
        [row.id]
      );
      await pool.query(
        `UPDATE users SET phone_number = $1, whatsapp_verified_at = NOW() WHERE id = $2`,
        [row.target, userId]
      );
      await endRecycledTrial(Number(userId), row.target);
    });

    return this.getStatus(userId);
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
