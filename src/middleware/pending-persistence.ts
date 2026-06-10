/**
 * Espejo en DB para los pending stores en memoria (tabla `pending_states`,
 * migración 097).
 *
 * Problema que resuelve: los 4 pending stores (activity / transaction /
 * observation / field-city) vivían SOLO en un Map del proceso. Un restart de
 * Railway (deploy, crash, OOM) borraba todos los pendings en vuelo — el
 * usuario que estaba respondiendo "¿en qué lote?" mandaba "Lote A" y eso se
 * clasificaba como mensaje nuevo (pérdida silenciosa del registro).
 *
 * Diseño: write-through asíncrono + hidratación fill-if-missing.
 *   - `persist()` / `remove()` son fire-and-forget: el Map sigue siendo la
 *     fuente de verdad del proceso y la API síncrona de los stores no cambia
 *     (hay ~125 call sites síncronos entre los 3 controllers).
 *   - `load()` se usa desde `hydrate()` de cada store, que los controllers
 *     llaman al inicio del procesamiento de cada mensaje. Solo rellena el Map
 *     cuando NO tiene la clave (después de un restart); nunca pisa estado en
 *     memoria más nuevo.
 *   - Tombstones: `remove()` registra un tombstone local de 60s para que una
 *     hidratación no "resucite" un pending recién cancelado cuyo DELETE en DB
 *     todavía está en vuelo.
 *
 * Errores de DB nunca rompen el flujo del mensaje — el peor caso es volver al
 * comportamiento anterior (pending solo en memoria).
 */

import { pool } from '../config/db.js';

const TOMBSTONE_TTL_MS = 60 * 1000;

export class PendingMirror<T extends { timestamp: number }> {
  private cleared = new Map<string, number>();

  constructor(
    private storeName: string,
    private ttlMs: number,
  ) {}

  /** Write-through asíncrono después de un set() en memoria. */
  persist(key: string, entry: T): void {
    this.cleared.delete(key);
    void pool
      .query(
        `INSERT INTO pending_states (store, key, payload, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (store, key) DO UPDATE SET payload = $3::jsonb, updated_at = NOW()`,
        [this.storeName, key, JSON.stringify(entry)],
      )
      .catch((err) => console.warn(`[pending-mirror:${this.storeName}] persist failed:`, (err as Error).message));
  }

  /** Borrado asíncrono después de un clear() en memoria. */
  remove(key: string): void {
    this.cleared.set(key, Date.now());
    void pool
      .query('DELETE FROM pending_states WHERE store = $1 AND key = $2', [this.storeName, key])
      .catch((err) => console.warn(`[pending-mirror:${this.storeName}] remove failed:`, (err as Error).message));
  }

  /**
   * Carga desde DB para hidratar el Map tras un restart. Respeta el TTL del
   * store (usa el timestamp guardado dentro del payload, así el pending no
   * "renace" con 5 minutos nuevos) y los tombstones locales.
   */
  async load(key: string): Promise<T | null> {
    const clearedAt = this.cleared.get(key);
    if (clearedAt != null) {
      if (Date.now() - clearedAt < TOMBSTONE_TTL_MS) return null;
      this.cleared.delete(key);
    }
    try {
      const { rows } = await pool.query(
        'SELECT payload FROM pending_states WHERE store = $1 AND key = $2',
        [this.storeName, key],
      );
      if (rows.length === 0) return null;
      const entry = rows[0].payload as T;
      if (!entry || typeof entry.timestamp !== 'number' || Date.now() - entry.timestamp > this.ttlMs) {
        this.remove(key);
        return null;
      }
      return entry;
    } catch (err) {
      console.warn(`[pending-mirror:${this.storeName}] load failed:`, (err as Error).message);
      return null;
    }
  }
}

/** Barrido de filas vencidas — lo llama el scheduler una vez por hora. */
export async function sweepExpiredPendingStates(): Promise<number> {
  try {
    const res = await pool.query(
      "DELETE FROM pending_states WHERE updated_at < NOW() - INTERVAL '1 hour'",
    );
    return res.rowCount ?? 0;
  } catch {
    return 0;
  }
}
