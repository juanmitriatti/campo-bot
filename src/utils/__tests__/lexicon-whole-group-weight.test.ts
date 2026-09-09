import { describe, it, expect } from 'vitest';
import { impliesWholeGroup, impliesWholeGroupIgnoringWeight } from '../lexicon.js';

/**
 * QA ganadería 9 sep 2026: "pesé los terneros, promedio 160 kg" preguntaba
 * "¿A cuántos animales?" porque impliesWholeGroup descarta cualquier texto con
 * dígitos, y un pesaje siempre trae el peso.
 */
describe('impliesWholeGroupIgnoringWeight', () => {
  it.each([
    'pesé los terneros, promedio 160 kg',
    'pesé las vacas del Norte 420 kilos promedio',
    'pesamos los novillos a 380,5 kg',
    'pesé todos los toros, 600 kg',
  ])('"%s" → grupo entero', (t) => {
    expect(impliesWholeGroup(t)).toBe(false); // el peso lo descalifica sin la variante
    expect(impliesWholeGroupIgnoringWeight(t)).toBe(true);
  });

  it.each([
    'pesé 10 terneros, 160 kg',
    'pesé terneros, 160 kg promedio',
    'pesé los 8 terneros a 160 kg',
  ])('"%s" → NO es el grupo entero (cantidad explícita o sin artículo)', (t) => {
    expect(impliesWholeGroupIgnoringWeight(t)).toBe(false);
  });
});
