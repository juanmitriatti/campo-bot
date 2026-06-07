import { describe, it, expect } from 'vitest';
import { extractReferencedAmountCorrection } from '../conversation-engine.js';

describe('extractReferencedAmountCorrection', () => {
  it('captures referent + amount: "no, el de urea eran 99 mil"', () => {
    const r = extractReferencedAmountCorrection('no, el de urea eran 99 mil');
    expect(r).toBeTruthy();
    expect(r!.categoryFilter).toBe('Fertilizantes');
    expect(r!.newAmount).toBe(99000);
  });
  it('"el de gasoil eran 70 mil" → Combustible / 70000', () => {
    const r = extractReferencedAmountCorrection('el de gasoil eran 70 mil');
    expect(r!.categoryFilter).toBe('Combustible');
    expect(r!.newAmount).toBe(70000);
  });
  it('"perdón, el gasto de semillas era 30 mil" → Semillas', () => {
    const r = extractReferencedAmountCorrection('perdón, el gasto de semillas era 30 mil');
    expect(r!.categoryFilter).toBe('Semillas');
    expect(r!.newAmount).toBe(30000);
  });
  it('does NOT hijack a plot/area correction: "el de norte era 50"', () => {
    expect(extractReferencedAmountCorrection('el de norte era 50')).toBeNull();
  });
  it('null on a plain new expense ("gasté 50 mil en gasoil")', () => {
    expect(extractReferencedAmountCorrection('gasté 50 mil en gasoil')).toBeNull();
  });
  it('null when no amount', () => {
    expect(extractReferencedAmountCorrection('el de urea está mal')).toBeNull();
  });
});
