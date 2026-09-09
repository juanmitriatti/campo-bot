import { pool } from '../../config/db.js';
import { getSetting, getSettingNumber } from '../../services/settings.service.js';
import { sendEmail, wrapHtml } from '../../services/mailer.service.js';
import { logError } from '../../services/error-logger.js';
import {
  generateOneTimeToken,
  findOneTimeToken,
  isTokenUsable,
  invalidatePendingTokens,
  markTokenUsed,
} from './one-time-token.js';

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
    `SELECT id, email, name, email_verified_at FROM users WHERE id = $1 AND deleted_at IS NULL`,
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
  const { raw: rawToken, hash: tokenHash } = generateOneTimeToken();
  const expiresAt = new Date(Date.now() + ttlH * 3_600_000);

  await invalidatePendingTokens('email_verification_tokens', user.id);
  await pool.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, email, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, tokenHash, user.email, expiresAt],
  );

  const publicUrl = ((await getSetting('PUBLIC_URL')) as string) || '';
  const link = `${publicUrl.replace(/\/$/, '')}/verify-email?token=${rawToken}`;

  try {
    const sent = await sendEmail({
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
    // sendEmail no tira: devuelve ok:false (sin API key, error de Resend).
    // Antes eso se reportaba como {ok:true} y el banner decía "reenviado".
    if (!sent.ok) {
      logError('auth', 'EMAIL_VERIFY_SEND_FAILED', new Error(sent.reason ?? 'unknown'), { userId: user.id });
      return { ok: false, reason: sent.reason ?? 'send_failed' };
    }
    return { ok: true };
  } catch (err) {
    logError('auth', 'EMAIL_VERIFY_SEND_FAILED', err as Error, { userId: user.id });
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Confirm a verification token: marks users.email_verified_at and the
 * token as used.
 *
 * Idempotente: el mismo link tocado dos veces (doble click, StrictMode del
 * dev, cliente de email que pre-abre el link) devuelve ok mientras el email
 * del token siga siendo el email verificado del usuario. Antes la segunda
 * pasada decía "Token inválido o vencido" sobre una cuenta ya verificada.
 */
export async function confirmVerificationToken(rawToken: string): Promise<{ userId: number; alreadyVerified?: boolean }> {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new EmailVerificationError(400, 'Token requerido');
  }

  const row = await findOneTimeToken('email_verification_tokens', rawToken);
  if (!row) {
    throw new EmailVerificationError(400, 'Token inválido o vencido');
  }

  // Reject if the user's current email differs from the token's bound email
  // (user changed email after issuing this token).
  const user = await getUser(row.user_id);
  if (!user || (user.email ?? '').toLowerCase() !== (row.email ?? '').toLowerCase()) {
    throw new EmailVerificationError(400, 'Token inválido (el email cambió)');
  }

  if (row.used_at) {
    if (user.email_verified_at) return { userId: user.id, alreadyVerified: true };
    throw new EmailVerificationError(400, 'Ese link ya se usó. Pedí uno nuevo desde Mi cuenta.');
  }
  if (!isTokenUsable(row)) {
    throw new EmailVerificationError(400, 'El link venció. Pedí uno nuevo desde Mi cuenta.');
  }

  await pool.query(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW())
     WHERE id = $1`,
    [row.user_id],
  );
  await markTokenUsed('email_verification_tokens', row.id);
  console.log(`[AUTH] email verificado user=${row.user_id}`);

  return { userId: row.user_id };
}

export async function getVerificationStatus(userId: number): Promise<{ email: string | null; emailVerified: boolean }> {
  const user = await getUser(userId);
  return {
    email: user?.email ?? null,
    emailVerified: !!user?.email_verified_at,
  };
}
