import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { pool } from '../../config/db.js';
import { AuthRepository } from './auth.repository.js';
import { TokenRepository } from './token.repository.js';
import { getSetting, getSettingNumber } from '../../services/settings.service.js';
import { sendEmail, wrapHtml } from '../../services/mailer.service.js';
import { logError } from '../../services/error-logger.js';

const BCRYPT_ROUNDS = 12;

export interface RequestResetResult {
  ok: true;
}

export interface ResetResult {
  ok: true;
}

export class PasswordRecoveryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'PasswordRecoveryError';
  }
}

export class PasswordRecoveryService {
  private auth: AuthRepository;
  private tokens: TokenRepository;

  constructor(authRepo?: AuthRepository, tokenRepo?: TokenRepository) {
    this.auth = authRepo ?? new AuthRepository();
    this.tokens = tokenRepo ?? new TokenRepository();
  }

  /**
   * Generate a reset token and email it to the user.
   *
   * Always returns success — even if the email isn't registered — to
   * prevent account enumeration. Side effects (token row, email) are
   * skipped silently when the user doesn't exist.
   */
  async requestReset(email: string): Promise<RequestResetResult> {
    if (!email || typeof email !== 'string') {
      throw new PasswordRecoveryError(400, 'Email requerido');
    }

    const user = await this.auth.findByEmail(email.trim().toLowerCase());
    if (!user) {
      // Don't leak: always 200.
      return { ok: true };
    }

    const ttlMin = (await getSettingNumber('PASSWORD_RESET_TTL_MINUTES')) || 60;
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + ttlMin * 60_000);

    // Invalidate any pending tokens for this user, then insert the fresh one.
    await pool.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt],
    );

    const publicUrl = ((await getSetting('PUBLIC_URL')) as string) || '';
    const link = `${publicUrl.replace(/\/$/, '')}/reset-password?token=${rawToken}`;

    try {
      await sendEmail({
        // El usuario se buscó POR email, así que user.email no puede ser null
        // acá; el tipo lo permite porque hay usuarios solo-teléfono. Se cae al
        // email normalizado de la consulta en vez de forzar el tipo.
        to: user.email ?? email.trim().toLowerCase(),
        subject: 'Recuperá tu contraseña — Campo Bot',
        text: `Hola ${user.name},\n\nPedí restablecer tu contraseña en Campo Bot. Abrí este link (vence en ${ttlMin} minutos):\n\n${link}\n\nSi no fuiste vos, ignorá este email.\n`,
        html: wrapHtml(
          'Recuperá tu contraseña',
          `<p>Hola <strong>${user.name}</strong>,</p>
           <p>Pediste restablecer tu contraseña en Campo Bot. El link de abajo vence en <strong>${ttlMin} minutos</strong>.</p>`,
          link,
          'Restablecer contraseña',
        ),
      });
    } catch (err) {
      logError('auth', 'PASSWORD_RESET_EMAIL_FAILED', err as Error, { userId: user.id });
    }

    return { ok: true };
  }

  /**
   * Validate the token and update the password. Single-use: the token row
   * is marked used_at on success and any other pending tokens for the user
   * are invalidated. Refresh tokens are also revoked so existing sessions
   * are kicked out.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<ResetResult> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new PasswordRecoveryError(400, 'Token requerido');
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      throw new PasswordRecoveryError(400, 'La contraseña debe tener al menos 8 caracteres');
    }

    // Pull all pending (unused, not expired) tokens — bcrypt comparison can't
    // be done in SQL so we have to candidate-match in JS. There's at most
    // one pending row per user thanks to the invalidation step above.
    const { rows } = await pool.query(
      `SELECT id, user_id, token_hash
         FROM password_reset_tokens
        WHERE used_at IS NULL AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 50`,
    );

    let matched: { id: number; user_id: number } | null = null;
    for (const row of rows) {
      const ok = await bcrypt.compare(rawToken, row.token_hash);
      if (ok) {
        matched = { id: row.id, user_id: row.user_id };
        break;
      }
    }

    if (!matched) {
      throw new PasswordRecoveryError(400, 'Token inválido o vencido');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.auth.setPasswordHash(matched.user_id, passwordHash);
    await pool.query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`,
      [matched.id],
    );
    // Force re-login on every device.
    await this.tokens.revokeAllUserTokens(matched.user_id);

    return { ok: true };
  }
}
