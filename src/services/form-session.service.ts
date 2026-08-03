import crypto from 'crypto';
import { pool } from '../config/db.js';

const TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 min, igual que map_tokens

export interface FormSessionRow {
  token: string;
  user_id: number;
  action: 'sow_crop' | 'harvest_crop';
  prefill: Record<string, unknown>;
  channel: string;
  channel_id: string;
  phone: string;
  had_pending: boolean;
  used_at: string | null;
  expires_at: string;
}

export class FormSessionService {
  async create(opts: {
    userId: number;
    action: 'sow_crop' | 'harvest_crop';
    prefill: Record<string, unknown>;
    channel: string;
    channelId: string;
    phone: string;
    hadPending: boolean;
  }): Promise<string> {
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);
    await pool.query(
      `INSERT INTO form_sessions (token, user_id, action, prefill, channel, channel_id, phone, had_pending, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
      [token, opts.userId, opts.action, JSON.stringify(opts.prefill),
       opts.channel, opts.channelId, opts.phone, opts.hadPending, expiresAt],
    );
    console.log(`[FORM] created action=${opts.action} user=${opts.userId} channel=${opts.channel} hadPending=${opts.hadPending}`);
    return token;
  }

  async validate(token: string): Promise<FormSessionRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM form_sessions WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [token],
    );
    return (rows[0] as FormSessionRow) ?? null;
  }

  async markUsed(token: string): Promise<void> {
    await pool.query(`UPDATE form_sessions SET used_at = NOW() WHERE token = $1`, [token]);
  }
}

export const formSessionService = new FormSessionService();
