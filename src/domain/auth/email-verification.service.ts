import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { pool } from '../../config/db.js';
import { getSetting, getSettingNumber } from '../../services/settings.service.js';
import { sendEmail, wrapHtml } from '../../services/mailer.service.js';
import { logError } from '../../services/error-logger.js';

const BCRYPT_ROUNDS = 12;

export class EmailVerificationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'EmailVerificationError';
  }
}

interface UserRow { id: number; email: string | null; name: string | null; email_verified_at: Date | null }

async function getUser(userId: number): Promise<UserRow | null> {
  const { rows } = await pool.query(
    `SELECT id, email, name, email_verified_at FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Generate a fresh verification token for the user's current email and
 * send it. Tied to the email at issue time so that email changes
 * invalidate prior tokens.
 */
export async function sendVerificationEmail(userId: number): Promise<{ ok: boolean; reason?: string }> {
  const user = await getUser(userId);
  if (!user || !user.email) return { ok: false, reason: 'no_user_or_email' };
  if (user.email_verified_at) return { ok: false, reason: 'already_verified' };

  const ttlH = (await getSettingNumber('EMAIL_VERIFY_TTL_HOURS')) || 24;
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + ttlH * 3_600_000);

  await pool.query(
    `UPDATE email_verification_tokens SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
    [user.id],
  );
  await pool.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, email, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, tokenHash, user.email, expiresAt],
  );

  const publicUrl = ((await getSetting('PUBLIC_URL')) as string) || '';
  const link = `${publicUrl.replace(/\/$/, '')}/verify-email?token=${rawToken}`;

  try {
    await sendEmail({
      to: user.email,
      subject: 'Verificá tu email — Campo Bot',
      text: `Hola ${user.name ?? ''},\n\nGracias por registrarte en Campo Bot. Para activar tu cuenta abrí este link (vence en ${ttlH} horas):\n\n${link}\n\nSi no fuiste vos, ignorá este email.\n`,
      html: wrapHtml(
        'Verificá tu email',
        `<p>Hola <strong>${user.name ?? ''}</strong>,</p>
         <p>Gracias por registrarte en Campo Bot. Para activar tu cuenta tocá el botón. El link vence en <strong>${ttlH} horas</strong>.</p>`,
        link,
        'Verificar email',
      ),
    });
    return { ok: true };
  } catch (err) {
    logError('auth', 'EMAIL_VERIFY_SEND_FAILED', err as Error, { userId: user.id });
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Confirm a verification token: marks users.email_verified_at and the
 * token as used. Idempotent: a second call with the same token errors out
 * (single-use), but if the email is already verified we return ok anyway.
 */
export async function confirmVerificationToken(rawToken: string): Promise<{ userId: number }> {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new EmailVerificationError(400, 'Token requerido');
  }

  const { rows } = await pool.query(
    `SELECT id, user_id, token_hash, email
       FROM email_verification_tokens
      WHERE used_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 50`,
  );

  let matched: { id: number; user_id: number; email: string } | null = null;
  for (const row of rows) {
    const ok = await bcrypt.compare(rawToken, row.token_hash);
    if (ok) {
      matched = row;
      break;
    }
  }

  if (!matched) {
    throw new EmailVerificationError(400, 'Token inválido o vencido');
  }

  // Reject if the user's current email differs from the token's bound email
  // (user changed email after issuing this token).
  const user = await getUser(matched.user_id);
  if (!user || user.email !== matched.email) {
    throw new EmailVerificationError(400, 'Token inválido (el email cambió)');
  }

  await pool.query(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW())
     WHERE id = $1`,
    [matched.user_id],
  );
  await pool.query(
    `UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1`,
    [matched.id],
  );

  return { userId: matched.user_id };
}

export async function getVerificationStatus(userId: number): Promise<{ email: string | null; emailVerified: boolean }> {
  const user = await getUser(userId);
  return {
    email: user?.email ?? null,
    emailVerified: !!user?.email_verified_at,
  };
}
