/**
 * Serialización de mensajes por usuario.
 *
 * Los webhooks responden 200 y procesan async sin lock: dos mensajes rápidos
 * del mismo usuario (típico: 3 audios seguidos) se procesaban en paralelo y
 * el segundo pisaba el pending del primero en los stores en memoria —
 * pérdida silenciosa de un registro.
 *
 * `withUserLock(key, fn)` encadena las ejecuciones por clave (teléfono /
 * chat id): cada mensaje espera a que termine el anterior DEL MISMO usuario.
 * Mensajes de usuarios distintos siguen corriendo en paralelo.
 *
 * In-process only — con múltiples réplicas haría falta un advisory lock de
 * Postgres, pero el deploy actual es single-replica y los pendings ya
 * persisten en DB (pending_states), que acota el daño restante.
 */

const tails = new Map<string, Promise<unknown>>();

// Textos en vuelo (corriendo o encolados) por clave de usuario. Una entrega
// duplicada del MISMO texto mientras el original todavía se procesa (proxy o
// fetch que reintenta, doble toque en WhatsApp) llegaba con id distinto, el
// dedup por id no la veía y el write se aplicaba dos veces: en el QA de
// siembra/cosecha (9 sep 2026) una cosecha parcial de 40 ha quedó en 80. Solo
// se descarta mientras el original está EN VUELO — un usuario que repite la
// misma respuesta a un pending segundos después sigue pasando.
const inFlight = new Map<string, Map<string, number>>();

export interface UserLockOptions<T> {
  /** Texto (u otro identificador de contenido) del mensaje, para el dedup en vuelo. */
  dedupKey?: string | null;
  /** Qué devolver cuando el mensaje se descarta por duplicado en vuelo. */
  onDuplicate?: () => T | Promise<T>;
}

export function withUserLock<T>(key: string, fn: () => Promise<T>, opts: UserLockOptions<T> = {}): Promise<T> {
  const dedupKey = opts.dedupKey ? opts.dedupKey.trim() : '';
  if (dedupKey) {
    const active = inFlight.get(key);
    if (active?.has(dedupKey)) {
      console.warn(`[INTERCEPT] dedup: texto idéntico en vuelo para ${key} — descartado ("${dedupKey.slice(0, 60)}")`);
      return Promise.resolve(opts.onDuplicate ? opts.onDuplicate() : (undefined as unknown as T));
    }
    if (!active) inFlight.set(key, new Map());
    inFlight.get(key)!.set(dedupKey, (inFlight.get(key)!.get(dedupKey) ?? 0) + 1);
  }
  const release = () => {
    if (!dedupKey) return;
    const active = inFlight.get(key);
    if (!active) return;
    const n = (active.get(dedupKey) ?? 1) - 1;
    if (n <= 0) active.delete(dedupKey); else active.set(dedupKey, n);
    if (active.size === 0) inFlight.delete(key);
  };
  const tail = tails.get(key) ?? Promise.resolve();
  // Ejecutar después de que el anterior SETTLEE (éxito o error) — un mensaje
  // que falló nunca debe trabar los siguientes del mismo usuario.
  const run = tail.then(fn, fn);
  const guard = run.then(
    () => { release(); },
    () => { release(); },
  );
  tails.set(key, guard);
  void guard.then(() => {
    if (tails.get(key) === guard) tails.delete(key);
  });
  return run;
}

/** Para tests. */
export function _clearUserLocks(): void {
  tails.clear();
  inFlight.clear();
}
