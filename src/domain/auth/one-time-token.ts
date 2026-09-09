import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { pool } from '../../config/db.js';

/**
 * Tokens de un solo uso que viajan por email (reset de contraseña y
 * verificación de email). Fuente ÚNICA de generación y lookup.
 *
 * Por qué sha256 y no bcrypt: el token son 32 bytes de CSPRNG (256 bits de
 * entropía), así que un hash rápido ya es irreversible desde la DB; bcrypt no
 * suma seguridad y, como no se puede comparar en SQL, obligaba a traer TODOS
 * los tokens pendientes del sistema y compararlos uno por uno (~250 ms cada
 * uno, LIMIT 50). Con 50+ tokens vivos (24 h de TTL en verificación alcanza
 * con 50 registros en un día) un link válido pero viejo quedaba fuera de la
 * ventana y el usuario veía "Token inválido o vencido" sin razón.
 *
 * Los tokens bcrypt emitidos antes de este cambio siguen valiendo hasta que
 * vencen: si el lookup exacto no encuentra nada, se prueba el camino viejo
 * sobre las filas con hash `$2…`.
 */

export type OneTimeTokenTable = 'password_reset_tokens' | 'email_verification_tokens';

const TABLES: ReadonlySet<string> = new Set<OneTimeTokenTable>(['password_reset_tokens', 'email_verification_tokens']);

export function hashOneTimeToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateOneTimeToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashOneTimeToken(raw) };
}

export interface PendingTokenRow {
  id: number;
  user_id: number;
  email: string | null;
  used_at: Date | null;
  expires_at: Date;
}

function assertTable(table: string): asserts table is OneTimeTokenTable {
  if (!TABLES.has(table)) throw new Error(`one-time-token: tabla no permitida «${table}»`);
}

/**
 * Busca el token (vigente o ya usado). Excluye usuarios borrados: un reset
 * sobre una cuenta soft-deleted le ponía contraseña a una fila sin email.
 *
 * Devuelve la fila aunque esté `used_at`/vencida para que el llamador pueda
 * distinguir "token desconocido" de "ya se usó" (idempotencia del verify).
 */
export async function findOneTimeToken(table: OneTimeTokenTable, raw: string): Promise<PendingTokenRow | null> {
  assertTable(table);
  if (!raw || typeof raw !== 'string' || raw.length > 256) return null;
  const emailCol = table === 'email_verification_tokens' ? 't.email' : 'NULL::varchar';

  const exact = await pool.query(
    `SELECT t.id, t.user_id, ${emailCol} AS email, t.used_at, t.expires_at
       FROM ${table} t
       JOIN users u ON u.id = t.user_id AND u.deleted_at IS NULL
      WHERE t.token_hash = $1
      ORDER BY t.created_at DESC
      LIMIT 1`,
    [hashOneTimeToken(raw)],
  );
  if (exact.rows.length > 0) return exact.rows[0];

  // Camino legacy (tokens bcrypt emitidos antes del cambio). Solo pendientes:
  // no vale la pena pagar bcrypt por filas ya usadas.
  const legacy = await pool.query(
    `SELECT t.id, t.user_id, ${emailCol} AS email, t.used_at, t.expires_at, t.token_hash
       FROM ${table} t
       JOIN users u ON u.id = t.user_id AND u.deleted_at IS NULL
      WHERE t.used_at IS NULL AND t.expires_at > NOW() AND t.token_hash LIKE '$2%'
      ORDER BY t.created_at DESC
      LIMIT 50`,
  );
  for (const row of legacy.rows) {
    if (await bcrypt.compare(raw, row.token_hash)) {
      const { token_hash: _h, ...rest } = row;
      return rest as PendingTokenRow;
    }
  }
  return null;
}

export function isTokenUsable(row: PendingTokenRow, now: Date = new Date()): boolean {
  return row.used_at == null && new Date(row.expires_at).getTime() > now.getTime();
}

/** Deja como usados todos los tokens pendientes del usuario (uno vivo por vez). */
export async function invalidatePendingTokens(table: OneTimeTokenTable, userId: number): Promise<void> {
  assertTable(table);
  await pool.query(`UPDATE ${table} SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
}

export async function markTokenUsed(table: OneTimeTokenTable, id: number): Promise<void> {
  assertTable(table);
  await pool.query(`UPDATE ${table} SET used_at = NOW() WHERE id = $1`, [id]);
}

/**
 * Limpieza: borra tokens vencidos o usados hace más de `olderThanDays`.
 * Lo corre el cleanup diario del scheduler; antes no había ninguna purga.
 */
export async function purgeStaleOneTimeTokens(olderThanDays = 7): Promise<{ reset: number; verify: number }> {
  const days = Math.max(1, Math.floor(olderThanDays));
  const reset = await pool.query(
    `DELETE FROM password_reset_tokens
      WHERE expires_at < NOW() - ($1 || ' days')::interval
         OR used_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  const verify = await pool.query(
    `DELETE FROM email_verification_tokens
      WHERE expires_at < NOW() - ($1 || ' days')::interval
         OR used_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return { reset: reset.rowCount ?? 0, verify: verify.rowCount ?? 0 };
}
