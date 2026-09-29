import crypto from 'crypto';
import { pool } from '../config/db.js';
import type { FormAction } from '../types/index.js';

const TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 min, igual que map_tokens

export type FormSessionMode = 'web' | 'flow' | 'conversation';
export type FormConversationStatus = 'collecting' | 'confirming' | 'parked' | 'submitted' | 'cancelled';

/** Estados en los que un formulario conversacional sigue abierto (retomable). */
export const LIVE_CONVERSATION_STATUSES: readonly FormConversationStatus[] = ['collecting', 'confirming', 'parked'];

export interface FormSessionRow {
  token: string;
  user_id: number;
  action: FormAction;
  prefill: Record<string, unknown>;
  channel: string;
  channel_id: string;
  phone: string;
  had_pending: boolean;
  used_at: string | null;
  expires_at: string;
  mode?: FormSessionMode;
  draft?: Record<string, unknown>;
  status?: FormConversationStatus | null;
  awaiting_field?: string | null;
  updated_at?: string;
}

export class FormSessionService {
  async create(opts: {
    userId: number;
    action: FormAction;
    prefill: Record<string, unknown>;
    channel: string;
    channelId: string;
    phone: string;
    hadPending: boolean;
    mode?: FormSessionMode;
  }): Promise<string> {
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);
    await pool.query(
      `INSERT INTO form_sessions (token, user_id, action, prefill, channel, channel_id, phone, had_pending, expires_at, mode)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
      [token, opts.userId, opts.action, JSON.stringify(opts.prefill),
       opts.channel, opts.channelId, opts.phone, opts.hadPending, expiresAt, opts.mode ?? 'web'],
    );
    console.log(`[FORM] created action=${opts.action} user=${opts.userId} channel=${opts.channel} hadPending=${opts.hadPending}`);
    return token;
  }

  /**
   * Sesión conversacional (WhatsApp sin Flows): draft durable con vencimiento
   * DESLIZANTE de `ttlHours` desde la última respuesta.
   */
  async createConversation(opts: {
    userId: number;
    action: FormAction;
    prefill: Record<string, unknown>;
    draft: Record<string, unknown>;
    channel: string;
    channelId: string;
    phone: string;
    hadPending: boolean;
    ttlHours: number;
  }): Promise<string> {
    const token = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO form_sessions (token, user_id, action, prefill, channel, channel_id, phone, had_pending,
                                  expires_at, mode, draft, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8,
               NOW() + make_interval(hours => $9::int), 'conversation', $10::jsonb, 'collecting')`,
      [token, opts.userId, opts.action, JSON.stringify(opts.prefill),
       opts.channel, opts.channelId, opts.phone, opts.hadPending,
       Math.max(1, Math.round(opts.ttlHours)), JSON.stringify(opts.draft)],
    );
    console.log(`[FORM] conversation created action=${opts.action} user=${opts.userId} ttl=${opts.ttlHours}h`);
    return token;
  }

  async validate(token: string): Promise<FormSessionRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM form_sessions
        WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
          AND (status IS NULL OR status <> 'cancelled')`,
      [token],
    );
    return (rows[0] as FormSessionRow) ?? null;
  }

  /** Fila del token SIN filtrar por vigencia (para explicar por qué murió). */
  async find(token: string): Promise<FormSessionRow | null> {
    const { rows } = await pool.query(`SELECT * FROM form_sessions WHERE token = $1`, [token]);
    return (rows[0] as FormSessionRow) ?? null;
  }

  /**
   * Sesión conversacional VIVA de ESE usuario. Toda lectura del colector pasa
   * por acá: vencida, usada, cancelada o ajena = null (anti-IDOR: un token de
   * otro usuario no existe para vos).
   */
  async getLiveConversation(token: string, userId: number): Promise<FormSessionRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM form_sessions
        WHERE token = $1 AND user_id = $2 AND mode = 'conversation'
          AND used_at IS NULL AND expires_at > NOW()
          AND status = ANY($3::text[])`,
      [token, userId, LIVE_CONVERSATION_STATUSES],
    );
    return (rows[0] as FormSessionRow) ?? null;
  }

  /** Igual que getLiveConversation pero sin exigir vigencia (para avisar "venció"). */
  async getConversation(token: string, userId: number): Promise<FormSessionRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM form_sessions WHERE token = $1 AND user_id = $2 AND mode = 'conversation'`,
      [token, userId],
    );
    return (rows[0] as FormSessionRow) ?? null;
  }

  /**
   * Sesión conversacional por PREFIJO del token (los ids de botón llevan 8
   * caracteres para entrar en los 64 bytes de Telegram). Siempre scopeada al
   * usuario que tapeó: un prefijo ajeno no existe.
   */
  async findConversationByPrefix(prefix: string, userId: number): Promise<FormSessionRow | null> {
    if (!/^[0-9a-f]{8}$/.test(prefix)) return null;
    const { rows } = await pool.query(
      `SELECT * FROM form_sessions
        WHERE user_id = $1 AND mode = 'conversation' AND token LIKE $2
        ORDER BY updated_at DESC LIMIT 1`,
      [userId, `${prefix}%`],
    );
    return (rows[0] as FormSessionRow) ?? null;
  }

  /** Persiste el draft y renueva el vencimiento deslizante. false = ya no está viva. */
  async saveConversation(
    token: string,
    userId: number,
    patch: { draft: Record<string, unknown>; status: FormConversationStatus; awaitingField: string | null },
    ttlHours: number,
  ): Promise<boolean> {
    const result = await pool.query(
      `UPDATE form_sessions
          SET draft = $3::jsonb, status = $4, awaiting_field = $5, updated_at = NOW(),
              expires_at = NOW() + make_interval(hours => $6::int)
        WHERE token = $1 AND user_id = $2 AND mode = 'conversation'
          AND used_at IS NULL AND expires_at > NOW()
          AND status = ANY($7::text[])`,
      [token, userId, JSON.stringify(patch.draft), patch.status, patch.awaitingField,
       Math.max(1, Math.round(ttlHours)), LIVE_CONVERSATION_STATUSES],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Cambia solo el estado (park / cancel) sin tocar el vencimiento. */
  async setConversationStatus(token: string, userId: number, status: FormConversationStatus): Promise<boolean> {
    const result = await pool.query(
      `UPDATE form_sessions SET status = $3, updated_at = NOW()
        WHERE token = $1 AND user_id = $2 AND mode = 'conversation' AND used_at IS NULL`,
      [token, userId, status],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Última sesión conversacional viva del usuario (opcionalmente de una acción). */
  async findResumable(userId: number, action?: FormAction | null): Promise<FormSessionRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM form_sessions
        WHERE user_id = $1 AND mode = 'conversation' AND used_at IS NULL AND expires_at > NOW()
          AND status = ANY($2::text[])
          AND ($3::text IS NULL OR action = $3)
        ORDER BY updated_at DESC LIMIT 1`,
      [userId, LIVE_CONVERSATION_STATUSES, action ?? null],
    );
    return (rows[0] as FormSessionRow) ?? null;
  }

  /** Último draft conversacional que VENCIÓ sin confirmarse (últimos 7 días). */
  async findRecentlyExpired(userId: number, action?: FormAction | null): Promise<FormSessionRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM form_sessions
        WHERE user_id = $1 AND mode = 'conversation' AND used_at IS NULL
          AND expires_at <= NOW() AND expires_at > NOW() - INTERVAL '7 days'
          AND status = ANY($2::text[])
          AND ($3::text IS NULL OR action = $3)
        ORDER BY updated_at DESC LIMIT 1`,
      [userId, LIVE_CONVERSATION_STATUSES, action ?? null],
    );
    return (rows[0] as FormSessionRow) ?? null;
  }

  /**
   * Reclamo ATÓMICO del token (idempotencia del submit). Corre dentro de la
   * transacción del commit: si el handler rechaza, el ROLLBACK lo libera. Dos
   * submits concurrentes (doble tap, webhook reintentado, doble POST) → el
   * segundo no reclama nada y NO escribe.
   */
  async claim(token: string): Promise<FormSessionRow | null> {
    const { rows } = await pool.query(
      `UPDATE form_sessions SET used_at = NOW(), status = CASE WHEN mode = 'conversation' THEN 'submitted' ELSE status END,
              updated_at = NOW()
        WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
          AND (status IS NULL OR status <> 'cancelled')
        RETURNING *`,
      [token],
    );
    return (rows[0] as FormSessionRow) ?? null;
  }

  async markUsed(token: string): Promise<void> {
    const result = await pool.query(`UPDATE form_sessions SET used_at = NOW() WHERE token = $1`, [token]);
    if (result.rowCount === 0) {
      console.warn(`[FORM] markUsed: token not found or already used: ${token}`);
    }
  }

  /** Purga diaria: sesiones vencidas hace más de `days` días. */
  async purgeExpired(days: number): Promise<number> {
    const result = await pool.query(
      `DELETE FROM form_sessions WHERE expires_at < NOW() - make_interval(days => $1::int)`,
      [days],
    );
    return result.rowCount ?? 0;
  }
}

export const formSessionService = new FormSessionService();
