import { pool } from '../../config/db.js';

export class TokenRepository {
  async saveRefreshToken(userId: number, tokenHash: string, expiresAt: Date): Promise<void> {
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt]
    );
  }

  async findValidToken(tokenHash: string): Promise<{ id: number; user_id: number; expires_at: Date } | null> {
    const { rows } = await pool.query(
      `SELECT id, user_id, expires_at FROM refresh_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async revokeToken(tokenHash: string): Promise<void> {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
      [tokenHash]
    );
  }

  async revokeAllUserTokens(userId: number): Promise<void> {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
  }

  async cleanExpiredTokens(): Promise<number> {
    const result = await pool.query(
      `DELETE FROM refresh_tokens WHERE expires_at < NOW()`
    );
    return result.rowCount ?? 0;
  }
}
