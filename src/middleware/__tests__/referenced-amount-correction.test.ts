import { describe, it, expect } from 'vitest';
import { extractReferencedAmountCorrection, extractLastRecordDateCorrection, isOtherItemCorrectionOrDelete } from '../conversation-engine.js';

describe('extractReferencedAmountCorrection', () => {
  it('expense referent (raw): "no, el de urea eran 99 mil"', () => {
    const r = extractReferencedAmountCorrection('no, el de urea eran 99 mil');
    expect(r).toMatchObject({ kind: 'expense', categoryFilter: 'urea', newAmount: 99000 });
  });
  it('"el de gasoil eran 70 mil" → expense, filter=gasoil', () => {
    expect(extractReferencedAmountCorrection('el de gasoil eran 70 mil')).toMatchObject({ kind: 'expense', categoryFilter: 'gasoil', newAmount: 70000 });
  });
  it('income referent: "el de soja eran 5 millones" → income', () => {
    const r = extractReferencedAmountCorrection('el de soja eran 5 millones');
    expect(r?.kind).toBe('income');
    expect(r?.newAmount).toBe(5000000);
  });
  it('explicit "el ingreso de girasol fue 1 millón" → income', () => {
    const r = extractReferencedAmountCorrection('el ingreso de girasol fue 1 millón');
    expect(r?.kind).toBe('income');
    expect(r?.newAmount).toBe(1000000);
  });
  it('explicit "el gasto de semillas era 30 mil" → expense', () => {
    expect(extractReferencedAmountCorrection('perdón, el gasto de semillas era 30 mil')).toMatchObject({ kind: 'expense', categoryFilter: 'semillas', newAmount: 30000 });
  });
  it('does NOT hijack a plot/area correction: "el de norte era 50"', () => {
    expect(extractReferencedAmountCorrection('el de norte era 50')).toBeNull();
  });
  it('null on a plain new expense', () => {
    expect(extractReferencedAmountCorrection('gasté 50 mil en gasoil')).toBeNull();
  });
  it('null when no amount', () => {
    expect(extractReferencedAmountCorrection('el de urea está mal')).toBeNull();
  });
});

describe('extractLastRecordDateCorrection', () => {
  it('"el último era de ayer" → ISO', () => expect(extractLastRecordDateCorrection('el último era de ayer')).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  it('"la última fue anteayer" → ISO', () => expect(extractLastRecordDateCorrection('la última fue anteayer')).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  it('does NOT fire on "fumigué ayer"', () => expect(extractLastRecordDateCorrection('fumigué ayer')).toBeNull());
  it('null without a relative date', () => expect(extractLastRecordDateCorrection('el último era en lote norte')).toBeNull());
});

describe('isOtherItemCorrectionOrDelete', () => {
  it.each([
    'no, el de gasoil fueron 9000',
    'el último era de ayer',
    'borrá el gasto de grasa',
    'eliminá el de gasoil',
  ])('"%s" → true', (t) => expect(isOtherItemCorrectionOrDelete(t)).toBe(true));
  it.each(['Norte', 'lote 3', 'sí', '50'])('"%s" → false', (t) => expect(isOtherItemCorrectionOrDelete(t)).toBe(false));
});

import { extractActivityQuantityCorrection } from '../conversation-engine.js';
describe('extractActivityQuantityCorrection', () => {
  it.each([
    ['no, eran 5.5 litros', 5.5, 'litros'],
    ['la fumigación eran 5 kg', 5, 'kg'],
    ['perdón, fueron 2 litros', 2, 'litros'],
  ])('"%s" → %f %s', (t, q, u) => {
    const r = extractActivityQuantityCorrection(t as string);
    expect(r?.quantity).toBe(q);
    expect(r?.unit).toBe(u);
  });
  it('rejects money: "no, eran 5 mil"', () => expect(extractActivityQuantityCorrection('no, eran 5 mil')).toBeNull());
  it('rejects money with currency: "no, eran 5000 dólares"', () => expect(extractActivityQuantityCorrection('no, eran 5000 dólares')).toBeNull());
  it('null on a new activity "fumigué 3 litros"', () => expect(extractActivityQuantityCorrection('fumigué 3 litros')).toBeNull());
});

import { extractCurrencyCorrection } from '../conversation-engine.js';
import { resolveAllRelativeDates } from '../../utils/relative-dates.js';
describe('extractCurrencyCorrection', () => {
  it.each(['no, eran dólares', 'perdón, en USD', 'eran u$d'])('"%s" → USD', (t) => expect(extractCurrencyCorrection(t)).toBe('USD'));
  it.each(['no, eran pesos', 'era en pesos'])('"%s" → ARS', (t) => expect(extractCurrencyCorrection(t)).toBe('ARS'));
  it('null on a new sale "vendí 10 tn de soja"', () => expect(extractCurrencyCorrection('vendí 10 tn de soja')).toBeNull());
});
describe('resolveAllRelativeDates', () => {
  it('orders multiple weekday phrases', () => {
    const r = resolveAllRelativeDates('cayeron 61mm el lunes, 62 el martes y 63 el sabado');
    expect(r).toHaveLength(3);
    expect(r.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    expect(new Set(r).size).toBe(3); // all distinct
  });
  it('single phrase → one date', () => expect(resolveAllRelativeDates('llovió el martes')).toHaveLength(1));
  it('no phrase → empty', () => expect(resolveAllRelativeDates('vendí soja')).toEqual([]));
});
