import { describe, it, expect } from 'vitest';
import { convertStockQuantity, canonicalStockUnit, storageUnit, isPerAreaUnit } from '../stock-units.js';
import { isOwnStorageDestination } from '../lexicon.js';

// Auditoría oct 2026, segunda ronda — STK-3, STK-10, STK-13.
describe('stock-units', () => {
  it.each([
    ['litros', 'lt', 5, 5],
    ['lts', 'lt', 5, 5],
    ['kilos', 'kg', 3, 3],
    ['tn', 'kg', 2, 2000],
    ['qq', 'kg', 3, 300],
    ['cc', 'lt', 500, 0.5],
    ['bolsas', 'bolsa', 4, 4],
  ])('%s → %s: %f → %f', (from, to, q, out) => expect(convertStockQuantity(q, from, to)).toBeCloseTo(out));

  it('dimensiones distintas no se convierten', () => {
    expect(convertStockQuantity(5, 'kg', 'lt')).toBeNull();
    expect(convertStockQuantity(5, 'bolsa', 'u')).toBeNull();
  });

  it('una dosis o un rinde por hectárea no es unidad de stock', () => {
    expect(isPerAreaUnit('qq/ha')).toBe(true);
    expect(isPerAreaUnit('lt/ha')).toBe(true);
    expect(canonicalStockUnit('kg/ha')).toBeNull();
    expect(isPerAreaUnit('kg')).toBe(false);
  });

  it('un ítem nuevo se guarda con la unidad canónica', () => {
    expect(storageUnit('Litros')).toBe('lt');
    expect(storageUnit('kilos')).toBe('kg');
    expect(storageUnit('rollos')).toBe('rollo');
  });
});

// AGR-14: «Agro Campo SA» es un acopiador, no el campo propio.
describe('isOwnStorageDestination', () => {
  it.each(['silo', 'silo bolsa', 'al silo', 'en el campo', 'galpón', 'propio', 'silobolsa'])('propio: %s', d =>
    expect(isOwnStorageDestination(d)).toBe(true));
  it.each(['Agro Campo SA', 'Cargill', 'Acopio La Casa', 'Bolsa de Cereales', null])('acopiador: %s', d =>
    expect(isOwnStorageDestination(d)).toBe(false));
});
