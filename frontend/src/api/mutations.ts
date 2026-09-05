/**
 * "Something was written" bus.
 *
 * Every non-GET request that succeeds through api/client.ts announces itself
 * here, and caches that derive from server state (the Resumen payload) drop
 * their copy. Before this, `invalidateOverview()` existed but nothing called
 * it: edit a gasto in its table, go back to Resumen, and the campaign result
 * still showed the old amount until the user pressed "Actualizar".
 *
 * A tiny module of its own so api/client.ts (the emitter) and the hooks (the
 * listeners) never import each other.
 */
type Listener = (info: { method: string; path: string }) => void;

const listeners = new Set<Listener>();

export function onMutation(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function notifyMutation(method: string, path: string): void {
  if (method.toUpperCase() === 'GET') return;
  for (const fn of listeners) {
    try { fn({ method, path }); } catch { /* a listener must never break a request */ }
  }
}
