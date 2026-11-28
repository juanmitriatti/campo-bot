/**
 * Qué acepta como respuesta la pregunta "¿a cuánto fue la compra/venta?".
 *
 * Fuente ÚNICA de esa decisión. Con la pregunta abierta llegan tres cosas que
 * se parecen (un número suelto) y no son lo mismo:
 *   - el PRECIO                         → lo toma la pregunta ("500 mil", "900");
 *   - una CORRECCIÓN DE CANTIDAD        → cambia las cabezas del movimiento
 *                                         ("perdón, eran 20", "no, eran 8 vacas");
 *   - el precio de OTRA categoría       → no es esta pregunta, se procesa aparte
 *                                         ("los toros salieron 2 palos").
 * Antes estas reglas estaban repartidas en condiciones dentro del pipeline, y
 * cada caso nuevo (un "perdón" con tilde, "no, eran 900") era un bug de datos:
 * un precio de $20 por cabeza, una compra de 1800 cabezas.
 */
import { extractCountCorrection } from '../../utils/self-correction.js';
import { headNumbersInText } from '../../utils/lexicon.js';
import { LivestockService } from './livestock.service.js';

export type PriceAnswer =
  | { kind: 'price' }
  | { kind: 'count_correction'; count: number }
  | { kind: 'other_category'; category: string };

const ANIMAL_RE = /\b(vacas?|vaquillonas?|toros?|toritos?|terner[oa]s?|novill(?:it)?os?|bueyes?)\b/g;
/** ternero/ternera, novillo/novillito… cuentan como la misma familia para esta pregunta. */
const family = (c: string): string => c.replace(/a$/, 'o');

export function classifyPriceAnswer(
  text: string,
  movement: { count: number; category: string | null } | undefined,
): PriceAnswer {
  const namesAnimal = headNumbersInText(text).length > 0;
  const count = extractCountCorrection(text);
  if (count != null) {
    // Sin nombrar el animal, un número grande o que multiplica la compra es plata.
    const tooBig = count >= 1000 || (!!movement && count > Math.max(movement.count * 5, 50));
    if (namesAnimal || !tooBig) return { kind: 'count_correction', count };
    return { kind: 'price' };
  }
  if (movement?.category) {
    const named = (text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(ANIMAL_RE) ?? [])
      .map(w => LivestockService.normalizeCategory(w))
      .filter((c): c is NonNullable<typeof c> => !!c);
    const other = named.find(c => family(c) !== family(String(movement.category)));
    if (named.length > 0 && other && !named.some(c => family(c) === family(String(movement.category)))) {
      return { kind: 'other_category', category: other };
    }
  }
  return { kind: 'price' };
}
