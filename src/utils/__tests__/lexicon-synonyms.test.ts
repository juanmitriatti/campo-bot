import { describe, it, expect } from 'vitest';
import { detectCurrencyTerm, hasDeleteVerb, stripAnswerPrefix } from '../lexicon.js';
import {
  extractCurrencyCorrection, extractAmountCorrection, extractActivityQuantityCorrection,
  isOtherItemCorrectionOrDelete,
} from '../../middleware/conversation-engine.js';

describe('lexicon — currency synonyms', () => {
  it.each(['dólares', 'usd', 'u$d', 'verdes', 'dolca'])('"%s" → USD', (w) => expect(detectCurrencyTerm(w)).toBe('USD'));
  it.each(['pesos', 'mangos', 'moneda nacional', 'guita'])('"%s" → ARS', (w) => expect(detectCurrencyTerm(w)).toBe('ARS'));
});

describe('extractCurrencyCorrection — synonyms', () => {
  it.each(['no, eran verdes', 'perdón, eran mangos', 'en realidad eran dólares'])('"%s" detected', (t) =>
    expect(extractCurrencyCorrection(t)).not.toBeNull());
  it('not on a new sale', () => expect(extractCurrencyCorrection('vendí 10 tn de soja')).toBeNull());
});

describe('extractAmountCorrection — broadened cues', () => {
  it.each([
    ['me equivoqué, eran 5000', 5000],
    ['más bien 12 mil', 12000],
    ['corrijo, son 8000', 8000],
    ['no, eran 20000', 20000],
  ])('"%s" → %i', (t, n) => expect(extractAmountCorrection(t as string)).toBe(n));
  it('does not fire on "norte"', () => expect(extractAmountCorrection('norte')).toBeNull());
});

describe('extractActivityQuantityCorrection — unit synonyms', () => {
  it.each([
    ['no, eran 5 lts', 5, 'lts'],
    ['perdón, fueron 200 gramos', 200, 'gramos'],
    ['eran 2 L', 2, 'l'],
  ])('"%s" → %f %s', (t, q, u) => {
    const r = extractActivityQuantityCorrection(t as string);
    expect(r?.quantity).toBe(q);
  });
  it('rejects money "no, eran 5 mil"', () => expect(extractActivityQuantityCorrection('no, eran 5 mil')).toBeNull());
});

describe('delete synonyms', () => {
  it.each([
    'anulá el gasto de gasoil',
    'dá de baja el ingreso de soja',
    'borrá el gasto de urea',
    'eliminá el de semillas',
  ])('"%s" → isOtherItemCorrectionOrDelete', (t) => expect(isOtherItemCorrectionOrDelete(t)).toBe(true));
  it('hasDeleteVerb("deshacer")', () => expect(hasDeleteVerb('deshacé eso')).toBe(true));
});

describe('stripAnswerPrefix', () => {
  it.each([
    ['no, en el Norte', 'Norte'],
    ['mejor el lote A1', 'A1'],
    ['en Sur', 'Sur'],
  ])('"%s" → "%s"', (i, o) => expect(stripAnswerPrefix(i as string)).toBe(o));
});
