import bcrypt from 'bcrypt';
import { pool, withTransaction } from '../../config/db.js';
import type { UserId } from '../../types/index.js';

export class AccountDeletionError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'AccountDeletionError';
  }
}

/**
 * Soft-deletes a user's account.
 *
 * Behaviour:
 *   - Requires the user's current password as confirmation.
 *   - Sets users.deleted_at = NOW() and status = 'deleted'.
 *   - Nulls out PII (email, phone_number, telegram_id, password_hash) so the
 *     same email/number can be re-registered immediately.
 *   - Revokes all refresh tokens for this user.
 *   - Owned rows (expenses, fields, etc.) keep their user_id link for the 30-day
 *     grace period. A cleanup job (added later) will hard-delete rows where
 *     deleted_at < NOW() - 30 days.
 */
export class AccountDeletionService {
  async deleteAccount(userId: UserId, currentPassword: string): Promise<void> {
    if (!currentPassword || currentPassword.trim().length < 1) {
      throw new AccountDeletionError(
        400,
        'PASSWORD_REQUIRED',
        'Tenés que confirmar tu contraseña actual para borrar la cuenta.',
      );
    }

    const userQ = await pool.query(
      `SELECT id, email, password_hash, deleted_at FROM users WHERE id = $1`,
      [userId],
    );
    if (userQ.rows.length === 0) {
      throw new AccountDeletionError(404, 'USER_NOT_FOUND', 'Usuario no encontrado.');
    }
    const user = userQ.rows[0];
    if (user.deleted_at) {
      throw new AccountDeletionError(410, 'ALREADY_DELETED', 'La cuenta ya fue eliminada.');
    }
    if (!user.password_hash) {
      throw new AccountDeletionError(
        400,
        'NO_PASSWORD',
        'Esta cuenta no tiene contraseña configurada. Contactá soporte.',
      );
    }

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) {
      throw new AccountDeletionError(401, 'WRONG_PASSWORD', 'Contraseña incorrecta.');
    }

    // Atomic: mark deleted + revoke tokens together.
    await withTransaction(async () => {
      await pool.query(
        `UPDATE users
         SET deleted_at = NOW(),
             status = 'deleted',
             email = NULL,
             phone_number = NULL,
             telegram_id = NULL,
             password_hash = NULL,
             whatsapp_verified_at = NULL,
             telegram_verified_at = NULL
         WHERE id = $1`,
        [userId],
      );
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    });
  }
}
