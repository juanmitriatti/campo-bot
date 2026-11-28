/**
 * Persistencia de los botones (tokens con datos) y de los toques de un solo uso.
 *
 * Las dos guardas siguen siendo síncronas y en memoria para quien las usa
 * (`callbackPayloadStore.set/get`, `consumeOnce`); este módulo las respalda en la
 * base con el mismo patrón que `PendingMirror`:
 *   - cada escritura se manda a la base sin frenar al llamador;
 *   - `flushCallbackState()` las espera ANTES de mandar la respuesta, así un
 *     botón que el usuario ve ya está guardado;
 *   - `hydrateCallbackState(owner)` trae lo del usuario al entrar cada mensaje
 *     o toque, así un reinicio o un deploy no vencen sus botones ni le dejan
 *     repetir una operación.
 * Si la base falla, el bot sigue andando solo con la memoria (como antes).
 */
import { pool } from '../config/db.js';

export const CALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

const inFlight = new Set<Promise<unknown>>();
/** Solo tests: lo anterior a este instante no se rehidrata (simula el vencimiento). */
let ignoreBefore = 0;

function track(run: () => Promise<unknown>, what: string): void {
  // Promise.resolve().then: un fallo síncrono (o una base simulada en tests) no
  // puede romper al que creó el botón.
  const guarded = Promise.resolve().then(run).catch((err) => console.warn(`[callback-state] ${what} falló: ${(err as Error).message}`));
  inFlight.add(guarded);
  void guarded.finally(() => inFlight.delete(guarded));
}

export function persistToken(token: string, owner: string | undefined, payload: string, createdAt: number): void {
  track(() => pool.query(
    `INSERT INTO callback_tokens (token, owner, payload, created_at, expires_at)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))
     ON CONFLICT (token) DO NOTHING`,
    [token, owner ?? null, payload, createdAt, createdAt + CALLBACK_TTL_MS],
  ), 'guardar botón');
}

export function persistUse(owner: string, key: string, usedAt: number): void {
  track(() => pool.query(
    `INSERT INTO callback_uses (owner, key, used_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))
     ON CONFLICT (owner, key) DO UPDATE SET used_at = EXCLUDED.used_at`,
    [owner, key, usedAt],
  ), 'guardar toque');
}

/** Espera las escrituras pendientes. Se llama antes de entregar la respuesta. */
export async function flushCallbackState(): Promise<void> {
  if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

export interface HydratedCallbackState {
  tokens: Array<{ token: string; payload: string; createdAt: number }>;
  uses: Array<{ key: string; usedAt: number }>;
}

export async function loadCallbackState(owner: string): Promise<HydratedCallbackState> {
  try {
    const [tokens, uses] = await Promise.all([
      pool.query(
        `SELECT token, payload, (extract(epoch FROM created_at) * 1000)::bigint AS created_ms
           FROM callback_tokens WHERE owner = $1 AND expires_at > now()`,
        [owner],
      ),
      pool.query(
        `SELECT key, (extract(epoch FROM used_at) * 1000)::bigint AS used_ms
           FROM callback_uses WHERE owner = $1 AND used_at > now() - interval '25 hours'`,
        [owner],
      ),
    ]);
    return {
      tokens: tokens.rows
        .map((r: { token: string; payload: string; created_ms: string }) => ({ token: r.token, payload: r.payload, createdAt: Number(r.created_ms) }))
        .filter((t: { createdAt: number }) => t.createdAt > ignoreBefore),
      uses: uses.rows
        .map((r: { key: string; used_ms: string }) => ({ key: r.key, usedAt: Number(r.used_ms) }))
        .filter((u: { usedAt: number }) => u.usedAt > ignoreBefore),
    };
  } catch (err) {
    console.warn(`[callback-state] no pude leer el estado de ${owner}: ${(err as Error).message}`);
    return { tokens: [], uses: [] };
  }
}

/** Purga diaria (cleanup del scheduler). */
export async function purgeCallbackState(): Promise<void> {
  await pool.query(`DELETE FROM callback_tokens WHERE expires_at < now() - interval '1 day'`);
  await pool.query(`DELETE FROM callback_uses WHERE used_at < now() - interval '2 days'`);
}

/** Solo tests: lo guardado hasta ahora deja de rehidratarse. */
export function _ignoreCallbackStateBeforeNow(): void {
  ignoreBefore = Date.now();
}
