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
const ONE_SHOT_PREFIXES = [
  'rain_field_',
  'rain_batch_',
  // Aplicar dos veces un lote de caravanas mueve los mismos animales dos veces
  // y deja dos filas en su línea de tiempo. El estado del batch
  // (`previewed → applied`) es la guarda real en la base; esto corta antes,
  // para poder contestar "ya se aplicó" en vez de procesar y descartar.
  'animal_batch_move_',
];

const used = new Map<string, number>();

export function isOneShotCallback(callbackId: string): boolean {
  return ONE_SHOT_PREFIXES.some(p => callbackId.startsWith(p));
}

/**
 * Qué contestarle al usuario cuando repite un tap de un solo uso.
 *
 * El mensaje tiene que hablar de LO QUE hizo, no de lluvia: un texto genérico
 * hardcodeado ("esa lluvia ya la registré") aparecía al re-tocar el botón de un
 * lote de caravanas. Al agregar un prefijo nuevo, agregá también su mensaje.
 */
export function repeatedTapMessage(callbackId: string): string {
  if (callbackId.startsWith('animal_batch_move_')) {
    return '✅ Esa lectura de caravanas ya la apliqué con ese toque. No volví a mover los animales.';
  }
  return '✅ Esa lluvia ya la registré con ese toque. No la sumé de nuevo.\n' +
         'Si de verdad llovió otra vez, escribime los milímetros nuevos.';
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
