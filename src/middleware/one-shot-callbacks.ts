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
  // "Sí, registrar" siembra + cosecha: un segundo tap anexaría los mismos
  // camiones a la cosecha del día (AGR-7).
  'sowharv_',
  // Repetir un comando guardado (cargas al lote, AGR-11): un doble tap las sumaría dos veces.
  'cmdtok_',
];

/**
 * Teclados de un solo uso POR TOKEN: todas las opciones de un mismo teclado
 * llevan el mismo token (8 chars, callback-payload-store) y se consume el
 * token, no el botón. Así un doble toque NI elegir otra opción del mismo
 * teclado repiten la operación: [En un lote]/[En un feedlot] ×2 sumaba 100
 * cabezas en vez de 50 y [Moverlos] ×2 hacía dos traslados (auditoría oct
 * 2026, HAC-9 / CONV-3). El grupo captura el token.
 */
const ONE_SHOT_TOKEN_GROUPS: RegExp[] = [
  /^lv_loc_(?:lote|feedlot)_([A-Za-z0-9_-]{8})$/,
  /^lv_loc_corralpick_([A-Za-z0-9_-]{8})$/,
  /^lv_move_(?:yes|new)_([A-Za-z0-9_-]{8})$/,
  /^lv_create_(?:corral|plot|feedlot|field)_continue_([A-Za-z0-9_-]{8})$/,
  /^lv_pick_loc_(?:health|repro|weigh)_([A-Za-z0-9_-]{8})_/,
  /^lv_animals_(?:all|skip)_(?:health|repro|weigh)_([A-Za-z0-9_-]{8})$/,
];

const used = new Map<string, number>();

/** Clave de consumo del tap: el token de su teclado, o el id entero. null = tap reutilizable. */
function oneShotKey(callbackId: string): string | null {
  for (const re of ONE_SHOT_TOKEN_GROUPS) {
    const m = callbackId.match(re);
    if (m) return `tok:${m[1]}`;
  }
  return ONE_SHOT_PREFIXES.some(p => callbackId.startsWith(p)) ? callbackId : null;
}

export function isOneShotCallback(callbackId: string): boolean {
  return oneShotKey(callbackId) !== null;
}

/**
 * Qué contestarle al usuario cuando repite un tap de un solo uso.
 *
 * El mensaje tiene que hablar de LO QUE hizo, no de lluvia: un texto genérico
 * hardcodeado ("esa lluvia ya la registré") aparecía al re-tocar el botón de un
 * lote de caravanas. Al agregar un prefijo nuevo, agregá también su mensaje.
 */
export function repeatedTapMessage(callbackId: string): string {
  if (ONE_SHOT_TOKEN_GROUPS.some(re => re.test(callbackId))) {
    return '✅ Esa opción ya la tomé con el primer toque. No repetí la operación.\n' +
           'Si querés hacer otra, escribime qué necesitás.';
  }
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
  const key = `${userId}:${oneShotKey(callbackId) ?? callbackId}`;
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
