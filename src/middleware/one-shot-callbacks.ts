/**
 * Taps de un solo uso.
 *
 * Un `callback_data` que lleva el DATO adentro (`rain_field_<campo>_<mm>`) es
 * reproducible para siempre: el botón queda vivo en el chat y cada tap vuelve a
 * ejecutar la acción. Para casi todos los botones eso es a lo sumo molesto —
 * genera una fila duplicada, visible y borrable.
 *
 * Para lluvia es corrupción silenciosa: `saveRainfall` SUMA cuando ya existe una
 * fila del mismo (usuario, campo, fecha) — un fix deliberado para "llovió a la
 * mañana y a la tarde". Así que dos entregas del mismo tap no dejan dos filas de
 * 100mm: dejan UNA de 200mm, indistinguible de un dato real. Reportado en prod
 * (Ago 2026): el usuario cargó 100mm y vio 200.
 *
 * Los dedups de canal (`dedup.ts`) cubren el reintento del MISMO update/mensaje.
 * No cubren dos entregas con ids distintos: doble toque del usuario (el botón no
 * da ninguna señal de haberse consumido), o dos procesos atendiendo el webhook
 * durante el solape de un deploy.
 *
 * Esta guarda es por (usuario, callback) y en proceso — misma limitación que
 * `dedup.ts` (single-replica), y suficiente para el caso real, que son dos
 * entregas con segundos de diferencia.
 */

const TTL_MS = 15 * 60 * 1000;

/**
 * Callbacks cuya re-ejecución corrompe datos en vez de solo duplicarlos.
 * Agregar acá cualquier tap nuevo que ACUMULE sobre una fila existente.
 */
const ONE_SHOT_PREFIXES = ['rain_field_', 'rain_batch_'];

const used = new Map<string, number>();

export function isOneShotCallback(callbackId: string): boolean {
  return ONE_SHOT_PREFIXES.some(p => callbackId.startsWith(p));
}

function cleanup(now: number): void {
  for (const [key, ts] of used) {
    if (now - ts > TTL_MS) used.delete(key);
  }
}

/**
 * `true` la primera vez que este usuario toca este botón; `false` después.
 * El llamador decide qué contestar — nunca silencio (invariante 1).
 */
export function consumeOnce(userId: number | string, callbackId: string): boolean {
  const now = Date.now();
  const key = `${userId}:${callbackId}`;
  const seen = used.get(key);
  if (seen !== undefined && now - seen <= TTL_MS) return false;
  used.set(key, now);
  if (used.size > 500) cleanup(now);
  return true;
}

/** Sólo para tests. */
export function _resetOneShotCallbacks(): void {
  used.clear();
}
