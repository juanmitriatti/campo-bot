import { describe, it, expect } from 'vitest';
import { isFuturePlanOnly } from '../lexicon.js';

// AGR-16 (auditoría oct 2026): red del servidor para invariante 12 (plan futuro ≠ registro).
describe('isFuturePlanOnly', () => {
  it.each([
    'el sábado fumigo el Norte',
    'mañana tengo que pagar el flete',
    'hay que vacunar la semana que viene',
    'el próximo martes siembro maíz',
    'acordame de pagar el arrendamiento',
  ])('plan: "%s"', (t) => expect(isFuturePlanOnly(t)).toBe(true));

  it.each([
    'fumigué el Norte',
    'mañana te paso el resto, gasté 50 mil de gasoil',
    'voy a cargar lo de ayer: 50 mil de gasoil',
    'sembramos soja en el Sur',
    'el sábado sembramos soja',
    'el lunes pasado fumigamos',
    'cosecharon el maíz',
    'pagué el flete, el mes que viene pago el otro',
  ])('NO es solo plan: "%s"', (t) => expect(isFuturePlanOnly(t)).toBe(false));
});
