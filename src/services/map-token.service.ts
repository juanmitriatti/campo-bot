import crypto from 'crypto';
import { pool } from '../config/db.js';

const TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

export interface MapToken {
  id: number;
  token: string;
  user_id: number;
  field_name: string;
  field_id: number | null;
  channel: string;
  channel_id: string;
  used: boolean;
  expires_at: Date;
}

export class MapTokenService {
  async createToken(
    userId: number,
    fieldName: string,
    fieldId: number | null,
    channel: string,
    channelId: string,
  ): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

    await pool.query(
      `INSERT INTO map_tokens (token, user_id, field_name, field_id, channel, channel_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [token, userId, fieldName, fieldId, channel, channelId, expiresAt],
    );

    return token;
  }

  async validateToken(token: string): Promise<MapToken | null> {
    const result = await pool.query(
      `SELECT * FROM map_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
      [token],
    );
    return result.rows[0] ?? null;
  }

  async markUsed(token: string): Promise<void> {
    await pool.query(`UPDATE map_tokens SET used = TRUE WHERE token = $1`, [token]);
  }
}
