import crypto from 'crypto';
import { pool } from '../../config/db.js';
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

function normalizeArPhone(input: string): string {
  // Strip spaces, dashes, dots, parens
  let p = input.replace(/[^\d+]/g, '');
  // If it starts with 0, strip it (AR domestic prefix)
  if (p.startsWith('0')) p = p.slice(1);
  // Add +54 if missing
  if (!p.startsWith('+')) {
    if (p.startsWith('54')) p = '+' + p;
    else p = '+54' + p;
  }
  return p;
}

function generateOtp(): string {
  // 6-digit numeric, zero-padded. Crypto-secure.
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

function generateLinkToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export class ChannelVerificationService {
  /**
   * Start WhatsApp verification: generate OTP, persist row, send via WhatsApp API.
   */
  async startWhatsApp(userId: UserId, rawPhone: string): Promise<StartWhatsAppResult> {
    if (!rawPhone || rawPhone.trim().length < 6) {
      throw new VerificationError(400, 'INVALID_PHONE', 'El número de teléfono es obligatorio.');
    }
    const phone = normalizeArPhone(rawPhone.trim());
    if (!/^\+\d{10,15}$/.test(phone)) {
      throw new VerificationError(400, 'INVALID_PHONE', 'Número inválido. Usá el formato +54 9 11 1234 5678.');
    }

    // Reject if another VERIFIED user already owns this phone
    const conflict = await pool.query(
      `SELECT id FROM users
       WHERE phone_number = $1 AND id <> $2 AND whatsapp_verified_at IS NOT NULL`,
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

    // Send OTP via WhatsApp. Strip leading + because the Cloud API accepts e164 without +.
    const waNumber = phone.startsWith('+') ? phone.slice(1) : phone;
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
       WHERE phone_number = $1 AND id <> $2 AND whatsapp_verified_at IS NOT NULL`,
      [row.target, userId]
    );
    if (conflict.rows.length > 0) {
      throw new VerificationError(
        409,
        'PHONE_TAKEN',
        'Este número ya está vinculado a otra cuenta.'
      );
    }

    await pool.query(
      `UPDATE channel_verifications SET verified_at = NOW() WHERE id = $1`,
      [row.id]
    );
    await pool.query(
      `UPDATE users SET phone_number = $1, whatsapp_verified_at = NOW() WHERE id = $2`,
      [row.target, userId]
    );

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
