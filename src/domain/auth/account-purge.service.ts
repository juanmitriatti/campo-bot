/**
 * Purga de las cuentas dadas de baja (CTA-12, oct 2026).
 *
 * La baja (Mi cuenta, panel /admin o "borrar mi cuenta" por chat) es un soft
 * delete: corta el acceso y pone en NULL nombre, teléfono y mail, pero los
 * registros (gastos, lotes, hacienda, conversaciones…) quedaban para siempre.
 * Este job, a los PURGE_AFTER_DAYS, borra todo lo que tenga el user_id del
 * usuario y sus archivos de documentos. Se conservan:
 *   - la fila de users (lápida sin datos personales, marcada con purged_at);
 *   - suscripciones y pagos (registro contable de lo cobrado).
 *
 * No adivina en campos compartidos: si el usuario era miembro de un campo
 * ajeno o tenía miembros en uno propio, lo saltea y lo loguea — sus registros
 * son también la historia del campo de otro, y eso lo decide una persona.
 *
 * Kill switch ACCOUNT_PURGE_ENABLED (default false: el primer run borra de
 * verdad y no hay backups en el plan actual de Railway). Todo se loguea con
 * [PURGE]; cada usuario corre en su propia transacción (todo o nada).
 */
import fs from 'fs/promises';
import path from 'path';
import { pool, withTransaction } from '../../config/db.js';
import { logError } from '../../services/error-logger.js';
import { getSettingBool } from '../../services/settings.service.js';

export const PURGE_AFTER_DAYS = 30;
const BATCH_PER_RUN = 25;
const STORAGE_PATH = process.env.DOCUMENT_STORAGE_PATH || '/data/documents';

/** Tablas con user_id que NO se purgan: registro contable de lo cobrado. */
const KEEP_TABLES = new Set(['subscriptions', 'payment_events']);

/**
 * Hijas SIN user_id directo (cuelgan de una tabla del usuario). Van dentro del
 * multi-pass porque pueden estar bloqueadas por tablas con user_id.
 */
const CHILD_DELETES = [
  `DELETE FROM observation_history WHERE observation_id IN (SELECT id FROM agro_observations WHERE user_id = $1)`,
  `DELETE FROM harvest_loads WHERE domain_event_id IN (SELECT id FROM domain_events WHERE user_id = $1)`,
  `DELETE FROM corrals WHERE feedlot_id IN (SELECT id FROM feedlots WHERE user_id = $1)`,
  `DELETE FROM stock_items WHERE warehouse_id IN (SELECT id FROM warehouses WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1))`,
  `DELETE FROM warehouses WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`,
  `DELETE FROM plot_aliases WHERE plot_id IN (SELECT p.id FROM plots p JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1)`,
  `DELETE FROM plot_crops WHERE plot_id IN (SELECT p.id FROM plots p JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1)`,
  `DELETE FROM crop_stages WHERE plot_id IN (SELECT p.id FROM plots p JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1)`,
  `DELETE FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`,
  `DELETE FROM pending_states WHERE key = 'testbot_' || $1::text`,
];

const PASSES = 4;

export type PurgeResult =
  | { status: 'purged'; rows: number; files: number }
  | { status: 'skipped'; reason: string };

function log(msg: string): void {
  console.log(`[PURGE] ${msg}`);
}

/** Corre una sentencia dentro de un SAVEPOINT: un choque de FK no aborta la transacción. */
async function tryDelete(sql: string, userId: number): Promise<number> {
  await pool.query('SAVEPOINT purge_stmt');
  try {
    const r = await pool.query(sql, [userId]);
    await pool.query('RELEASE SAVEPOINT purge_stmt');
    return r.rowCount ?? 0;
  } catch (err) {
    await pool.query('ROLLBACK TO SAVEPOINT purge_stmt');
    const code = (err as { code?: string }).code;
    // 23503 = FK: otra tabla todavía la referencia, se resuelve en la próxima pasada.
    // 42P01/42703 = tabla/columna que no existe en este esquema.
    if (code === '23503' || code === '42P01' || code === '42703') return 0;
    throw err;
  }
}

async function userTables(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.column_name = 'user_id' AND c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE' AND c.table_name <> 'users'`,
  );
  return rows.map(r => r.table_name as string).filter(t => !KEEP_TABLES.has(t)).sort();
}

/** Motivo para NO purgar a este usuario automáticamente, o null. */
async function skipReason(userId: number): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM field_members fm JOIN fields f ON f.id = fm.field_id
                WHERE fm.user_id = $1 AND f.user_id <> $1 AND f.deleted_at IS NULL) AS member_elsewhere,
       EXISTS (SELECT 1 FROM field_members fm JOIN fields f ON f.id = fm.field_id
                JOIN users m ON m.id = fm.user_id
                WHERE f.user_id = $1 AND fm.user_id <> $1 AND m.deleted_at IS NULL) AS has_members`,
    [userId],
  );
  if (rows[0]?.member_elsewhere) return 'es miembro de un campo de otro usuario';
  if (rows[0]?.has_members) return 'tiene un campo compartido con miembros activos';
  return null;
}

/**
 * Purga los registros de UNA cuenta dada de baja. Exige que esté dada de baja
 * (deleted_at) y no purgada; no mira la antigüedad (eso lo decide el batch).
 */
export async function purgeDeletedUser(userId: number): Promise<PurgeResult> {
  const u = await pool.query(`SELECT deleted_at, purged_at FROM users WHERE id = $1`, [userId]);
  if (!u.rows[0]) return { status: 'skipped', reason: 'no existe' };
  if (!u.rows[0].deleted_at) return { status: 'skipped', reason: 'la cuenta no está dada de baja' };
  if (u.rows[0].purged_at) return { status: 'skipped', reason: 'ya purgada' };
  const reason = await skipReason(userId);
  if (reason) return { status: 'skipped', reason };

  const docs = await pool.query(`SELECT compressed_path FROM documents WHERE user_id = $1 AND compressed_path IS NOT NULL`, [userId])
    .catch(() => ({ rows: [] as Array<{ compressed_path: string }> }));
  const tables = await userTables();

  const rows = await withTransaction(async () => {
    let total = 0;
    for (let pass = 0; pass < PASSES; pass++) {
      for (const sql of CHILD_DELETES) total += await tryDelete(sql, userId);
      for (const t of tables) total += await tryDelete(`DELETE FROM "${t}" WHERE user_id = $1`, userId);
    }
    // Todo o nada: si algo quedó (una FK que no se resolvió), no se marca purgada.
    const left: string[] = [];
    for (const t of tables) {
      const r = await pool.query(`SELECT 1 FROM "${t}" WHERE user_id = $1 LIMIT 1`, [userId]);
      if (r.rows.length > 0) left.push(t);
    }
    if (left.length > 0) throw new Error(`quedaron filas en: ${left.join(', ')}`);
    // Bajas viejas (antes de CTA-12) no ponían todo en NULL: la lápida queda sin datos personales.
    await pool.query(
      `UPDATE users SET purged_at = NOW(), status = 'deleted',
              name = NULL, last_name = NULL, city = NULL, province = NULL,
              email = NULL, phone_number = NULL, telegram_id = NULL, password_hash = NULL,
              whatsapp_verified_at = NULL, telegram_verified_at = NULL
        WHERE id = $1`,
      [userId],
    );
    return total;
  });

  // Archivos: después del commit (si el disco falla, los registros ya no existen).
  let files = 0;
  for (const d of docs.rows) {
    try {
      await fs.unlink(path.join(STORAGE_PATH, d.compressed_path));
      files++;
    } catch { /* ya no estaba */ }
  }
  await fs.rm(path.join(STORAGE_PATH, String(userId)), { recursive: true, force: true }).catch(() => {});
  return { status: 'purged', rows, files };
}

/** Job nocturno: purga hasta BATCH_PER_RUN cuentas dadas de baja hace más de PURGE_AFTER_DAYS. */
export async function purgeDeletedAccounts(opts: { limit?: number; force?: boolean } = {}): Promise<{ purged: number; skipped: number; failed: number }> {
  const summary = { purged: 0, skipped: 0, failed: 0 };
  if (!opts.force && (await getSettingBool('ACCOUNT_PURGE_ENABLED')) !== true) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users
        WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND deleted_at < NOW() - $1::int * INTERVAL '1 day'`,
      [PURGE_AFTER_DAYS],
    );
    if (rows[0]?.n > 0) log(`apagado (ACCOUNT_PURGE_ENABLED=false): ${rows[0].n} cuenta(s) dadas de baja hace más de ${PURGE_AFTER_DAYS} días esperando purga`);
    return summary;
  }
  // Sin LIMIT en la consulta: los salteados (campos compartidos) son baratos y
  // no deben ocupar el cupo de la noche; el tope cuenta solo lo purgado.
  const limit = opts.limit ?? BATCH_PER_RUN;
  const { rows } = await pool.query(
    `SELECT id FROM users
      WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND deleted_at < NOW() - $1::int * INTERVAL '1 day'
      ORDER BY deleted_at`,
    [PURGE_AFTER_DAYS],
  );
  for (const r of rows) {
    if (summary.purged >= limit) break;
    const id = Number(r.id);
    try {
      const res = await purgeDeletedUser(id);
      if (res.status === 'purged') {
        summary.purged++;
        log(`user ${id}: purgado (${res.rows} filas, ${res.files} archivos)`);
      } else {
        summary.skipped++;
        log(`user ${id}: salteado — ${res.reason}`);
      }
    } catch (err) {
      summary.failed++;
      log(`user ${id}: FALLÓ — ${(err as Error).message}`);
      logError('account', 'PURGE_FAILED', err as Error, { userId: id });
    }
  }
  return summary;
}
