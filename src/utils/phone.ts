/**
 * phone.ts — FUENTE ÚNICA de verdad para números de teléfono de cuenta.
 *
 * Por qué existe: `users.phone_number` es UNIQUE y convivía con TRES formatos
 * producidos por tres caminos distintos:
 *
 *   1. El webhook de WhatsApp guarda `message.from` crudo → `5492364469135`.
 *   2. `ChannelVerificationService` guardaba el resultado de su propio
 *      `normalizeArPhone()` → `+54...`, y encima SIN el 9 de celular
 *      ("2364469135" salía `+542364469135`).
 *   3. El alta manual del admin pedía "como lo manda WhatsApp, sin +".
 *
 * Consecuencia en prod: quien vinculaba WhatsApp desde la web quedaba con un
 * `phone_number` que el webhook NUNCA volvía a encontrar
 * (`findVerifiedByPhone` compara exacto), así que al escribirle al bot recibía
 * "creá tu cuenta" para siempre. Y sin una forma canónica, "compartir un campo
 * con un número" es inconstruible: no hay con qué comparar.
 *
 * Forma canónica: `549` + 10 dígitos nacionales, SIN `+`.
 * Se eligió sin `+` porque es lo que manda Meta y lo que ya tenía la mayoría de
 * las filas; además las claves de los pending stores (`wa:<phone>`,
 * `hydratePendingStores(phone)`, `PendingMirror`) se derivan de ese valor, y
 * cambiarlo obligaría a reescribirlas.
 *
 * ESPEJO SQL: la función `canonical_phone_ar(text)` (migración 122) hace lo
 * MISMO que `normalizePhone()`. Los dos lados deben mantenerse equivalentes —
 * hay un test de tabla que los corre contra los mismos casos.
 * Mismo patrón que `entity-matcher.ts` (`sqlNormalizedName` ↔ `compactEntityName`).
 */

/** Placeholder que usa el alta por Telegram cuando no hay teléfono real. */
export function isTelegramPlaceholder(raw: string): boolean {
  return /^tg_/.test(raw);
}

/**
 * Normaliza a la forma canónica `549XXXXXXXXXX`.
 *
 * Devuelve `null` si no se puede afirmar un celular argentino válido — nunca
 * inventa un número. Los placeholders `tg_<id>` vuelven intactos: son una
 * identidad legítima, no un teléfono mal escrito.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isTelegramPlaceholder(trimmed)) return trimmed;

  let d = trimmed.replace(/\D/g, '');
  if (!d) return null;

  // Prefijo internacional marcado como 00 (00549...)
  if (d.startsWith('00')) d = d.slice(2);

  let nat: string;
  if (d.startsWith('54')) {
    nat = d.slice(2);
    // El 9 de celular va entre el país y la característica. Ninguna
    // característica argentina arranca con 9, así que esto no es ambiguo.
    if (nat.startsWith('9')) nat = nat.slice(1);
  } else {
    nat = d;
  }

  // 0 de larga distancia doméstica (0221...)
  while (nat.startsWith('0')) nat = nat.slice(1);

  // "15" doméstico, que va DESPUÉS de la característica (0221 15 4123456).
  // La característica es de 2, 3 o 4 dígitos, así que el 15 puede estar en
  // tres posiciones; con 12 dígitos y un 15 en la posición correcta, sacarlo
  // deja los 10 nacionales.
  if (nat.length === 12) {
    if (nat.startsWith('11') && nat.slice(2, 4) === '15') nat = '11' + nat.slice(4);
    else if (nat.slice(3, 5) === '15') nat = nat.slice(0, 3) + nat.slice(5);
    else if (nat.slice(4, 6) === '15') nat = nat.slice(0, 4) + nat.slice(6);
  }

  if (nat.length !== 10) return null;
  return '549' + nat;
}

/** ¿Este texto es un teléfono y nada más? Para el slot-extractor. */
export function looksLikePhone(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  // Un teléfono escrito a mano lleva dígitos, espacios, guiones, puntos,
  // paréntesis y a lo sumo un + inicial. Cualquier letra lo descarta: así
  // "el sábado" o "lote 15" nunca se confunden con un número.
  if (!/^\+?[\d\s().-]{8,25}$/.test(t)) return false;
  return normalizePhone(t) !== null;
}

/**
 * Para mostrar. NUNCA para comparar — para eso está normalizePhone/samePhone.
 *
 * No se agrupa la parte nacional a propósito: la característica argentina es de
 * 2, 3 o 4 dígitos y no se puede inferir sin una tabla de códigos de área.
 * Agrupar adivinando muestra el número mal ("236 4469135" en vez de
 * "2364 469135"), y un teléfono mal cortado se lee como otro número.
 */
export function formatPhoneAR(canonical: string | null | undefined): string {
  if (!canonical) return '';
  if (isTelegramPlaceholder(canonical)) return canonical;
  const c = normalizePhone(canonical);
  if (!c) return String(canonical);
  return `+54 9 ${c.slice(3)}`;
}

/**
 * Los dos valores apuntan a la misma persona. Usar SIEMPRE esto en vez de
 * `a === b` sobre teléfonos: las filas viejas todavía tienen formatos legacy
 * hasta que la migración 122 y el script de fusión terminen de pasar.
 */
export function samePhone(a: unknown, b: unknown): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return na !== null && nb !== null && na === nb;
}
