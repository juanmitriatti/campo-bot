import { describe, it, expect } from 'vitest';
import { extractSlots } from '../slot-extractor.js';

/**
 * QA ganadería 9 sep 2026: con "¿en qué lote?" abierto, "en 5 hectáreas del
 * Sur tengo vaquillonas" se consumió como lote «5». Un número seguido de una
 * unidad nunca es un lote.
 */
describe('extractSlots — plot pelado "en N"', () => {
  it.each([
    ['en A1', 'A1'],
    ['en 5', '5'],
    ['en el lote 12', '12'],
    ['lote B2', 'B2'],
  ])('"%s" → plot %s', (text, plot) => {
    expect(extractSlots(text, { type: 'activity' }).plot).toBe(plot);
  });

  it.each([
    'en 5 hectáreas del Sur tengo vaquillonas',
    'en 5 has',
    'en 40 ha sembré soja',
    'en 3 días fumigo',
    'llovieron en 20 mm',
  ])('"%s" → sin plot (número + unidad)', (text) => {
    expect(extractSlots(text, { type: 'activity' }).plot).toBeUndefined();
  });
});
