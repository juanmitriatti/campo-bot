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

export function withUserLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = tails.get(key) ?? Promise.resolve();
  // Ejecutar después de que el anterior SETTLEE (éxito o error) — un mensaje
  // que falló nunca debe trabar los siguientes del mismo usuario.
  const run = tail.then(fn, fn);
  const guard = run.then(
    () => undefined,
    () => undefined,
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
}
