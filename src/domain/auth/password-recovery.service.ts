import bcrypt from 'bcrypt';
import { pool } from '../../config/db.js';
import { AuthRepository } from './auth.repository.js';
import { TokenRepository } from './token.repository.js';
import { normalizeEmail } from './email-normalizer.js';
import {
  generateOneTimeToken,
  findOneTimeToken,
  isTokenUsable,
  invalidatePendingTokens,
  markTokenUsed,
} from './one-time-token.js';
import { getSetting, getSettingNumber } from '../../services/settings.service.js';
import { sendEmail, wrapHtml } from '../../services/mailer.service.js';
import { logError } from '../../services/error-logger.js';

const BCRYPT_ROUNDS = 12;

export interface RequestResetResult {
  ok: true;
}

export interface ResetResult {
  ok: true;
  userId: number;
  /** Email de la cuenta (normalizado): la ruta libera el bloqueo de login. */
  email: string | null;
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

    // El lookup es case-insensitive (auth.repository): antes se lowercaseaba
    // acá pero el registro guardaba el email tal cual, así que un usuario
    // registrado como "Juan@Gmail.com" nunca recibía el link (200 mudo).
    const user = await this.auth.findByEmail(normalizeEmail(email));
    if (!user) {
      // Don't leak: always 200.
      console.log('[AUTH] forgot-password para email desconocido (200 igual, sin envío)');
      return { ok: true };
    }
    if (user.status === 'disabled' || user.status === 'suspended') {
      // Cuenta bloqueada por admin: no se manda link (no podría loguearse
      // igual) pero tampoco se revela. Log para que no sea un silencio.
      console.log(`[AUTH] forgot-password sobre cuenta ${user.status} user=${user.id}: sin envío`);
      return { ok: true };
    }

    const ttlMin = (await getSettingNumber('PASSWORD_RESET_TTL_MINUTES')) || 60;
    const { raw: rawToken, hash: tokenHash } = generateOneTimeToken();
    const expiresAt = new Date(Date.now() + ttlMin * 60_000);

    // Invalidate any pending tokens for this user, then insert the fresh one.
    await invalidatePendingTokens('password_reset_tokens', user.id);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt],
    );

    const publicUrl = ((await getSetting('PUBLIC_URL')) as string) || '';
    const link = `${publicUrl.replace(/\/$/, '')}/reset-password?token=${rawToken}`;

    try {
      const sent = await sendEmail({
        // El usuario se buscó POR email, así que user.email no puede ser null
        // acá; el tipo lo permite porque hay usuarios solo-teléfono.
        to: user.email ?? normalizeEmail(email),
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
      if (!sent.ok) {
        logError('auth', 'PASSWORD_RESET_EMAIL_FAILED', new Error(sent.reason ?? 'unknown'), { userId: user.id });
      }
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

    const row = await findOneTimeToken('password_reset_tokens', rawToken);
    if (!row) {
      throw new PasswordRecoveryError(400, 'Token inválido o vencido');
    }
    if (row.used_at) {
      throw new PasswordRecoveryError(400, 'Ese link ya se usó. Si necesitás cambiar la contraseña de nuevo, pedí uno nuevo.');
    }
    if (!isTokenUsable(row)) {
      throw new PasswordRecoveryError(400, 'El link venció. Pedí uno nuevo desde «Olvidé mi contraseña».');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.auth.setPasswordHash(row.user_id, passwordHash);
    await markTokenUsed('password_reset_tokens', row.id);
    // Force re-login on every device.
    await this.tokens.revokeAllUserTokens(row.user_id);
    console.log(`[AUTH] contraseña restablecida user=${row.user_id} (sesiones revocadas)`);

    const user = await this.auth.getUserById(row.user_id);
    return { ok: true, userId: row.user_id, email: user?.email ? normalizeEmail(user.email) : null };
  }
}
