import bcrypt from 'bcrypt';
import { pool, withTransaction } from '../../config/db.js';
import { logError } from '../../services/error-logger.js';
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
        'Esta cuenta no tiene contraseña. Para darla de baja, escribile «borrar mi cuenta» al bot.',
      );
    }

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) {
      throw new AccountDeletionError(401, 'WRONG_PASSWORD', 'Contraseña incorrecta.');
    }

    await this.softDelete(userId);
  }

  /**
   * Baja desde el panel /admin: el MISMO borrado que pide el usuario, sin la
   * contraseña. Antes el admin hacía un DELETE físico tabla por tabla, con una
   * lista a mano desactualizada y sin transacción: chocaba con livestock_groups
   * (FK a plots) después de haber borrado ya los eventos y conversaciones del
   * usuario (prod, 17 oct 2026).
   */
  async deleteByAdmin(userId: UserId): Promise<void> {
    await this.deleteWithoutPassword(userId);
  }

  /**
   * Baja pedida por chat ("borrar mi cuenta" + botón de un uso). Sin
   * contraseña: quien escribe desde el canal verificado ES el dueño de la
   * cuenta, y las cuentas que solo usan el bot no tienen contraseña (Mi cuenta
   * les decía "Contactá soporte").
   */
  async deleteFromChat(userId: UserId): Promise<void> {
    await this.deleteWithoutPassword(userId);
  }

  private async deleteWithoutPassword(userId: UserId): Promise<void> {
    const { rows } = await pool.query(`SELECT id, deleted_at FROM users WHERE id = $1`, [userId]);
    if (rows.length === 0) {
      throw new AccountDeletionError(404, 'USER_NOT_FOUND', 'Usuario no encontrado.');
    }
    if (rows[0].deleted_at) {
      throw new AccountDeletionError(410, 'ALREADY_DELETED', 'La cuenta ya fue eliminada.');
    }
    await this.softDelete(userId);
  }

  private async softDelete(userId: UserId): Promise<void> {
    // Las claves de canal se leen ANTES de poner el teléfono en NULL.
    const ch = await pool.query(`SELECT phone_number, telegram_id FROM users WHERE id = $1`, [userId]);
    const channelKeys = new Set<string>([`testbot_${userId}`]);
    if (ch.rows[0]?.phone_number) channelKeys.add(String(ch.rows[0].phone_number));
    if (ch.rows[0]?.telegram_id) channelKeys.add(`tg_${ch.rows[0].telegram_id}`);

    // Atomic: mark deleted + revoke tokens together.
    await withTransaction(async () => {
      await pool.query(
        `UPDATE users
         SET deleted_at = NOW(),
             status = 'deleted',
             -- CTA-12: nombre, apellido y localidad también son datos personales.
             name = NULL,
             last_name = NULL,
             city = NULL,
             province = NULL,
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

    // CTA-16: la sesión de la cuenta borrada se corta ya.
    const { invalidateAccountState } = await import('../../middleware/auth.middleware.js');
    invalidateAccountState(Number(userId));

    // Invariante 15: lo que tenía abierto (tarjetas, preguntas, colas) no
    // sobrevive a la baja — si el número se vuelve a registrar, arranca limpio.
    try {
      const { clearAllUserPendingState } = await import('../../services/message-pipeline.js');
      for (const key of channelKeys) await clearAllUserPendingState(key);
    } catch (err) {
      logError('account', 'DELETE_PENDING_CLEAR_FAILED', err as Error, { userId: Number(userId) });
    }

    // CTA-6: la cuenta borrada seguía con la suscripción viva y MercadoPago
    // seguía cobrando. Después del commit (el borrado no depende del proveedor).
    try {
      const { SubscriptionService } = await import('../billing/subscription.service.js');
      await new SubscriptionService().closeForDeletedAccount(userId);
    } catch (err) {
      logError('account', 'DELETE_SUBSCRIPTION_CLOSE_FAILED', err as Error, { userId: Number(userId) });
    }
  }
}
