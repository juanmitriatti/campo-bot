import { describe, it, expect } from 'vitest';
import { extractReferencedAmountCorrection } from '../conversation-engine.js';

describe('extractReferencedAmountCorrection', () => {
  it('expense referent: "no, el de urea eran 99 mil"', () => {
    const r = extractReferencedAmountCorrection('no, el de urea eran 99 mil');
    expect(r).toMatchObject({ kind: 'expense', categoryFilter: 'Fertilizantes', newAmount: 99000 });
  });
  it('"el de gasoil eran 70 mil" → expense Combustible', () => {
    expect(extractReferencedAmountCorrection('el de gasoil eran 70 mil')).toMatchObject({ kind: 'expense', categoryFilter: 'Combustible', newAmount: 70000 });
  });
  it('income referent: "el de soja eran 5 millones" → income Soja', () => {
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
    expect(extractReferencedAmountCorrection('perdón, el gasto de semillas era 30 mil')).toMatchObject({ kind: 'expense', categoryFilter: 'Semillas', newAmount: 30000 });
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

import { extractLastRecordDateCorrection } from '../conversation-engine.js';
describe('extractLastRecordDateCorrection', () => {
  it('"el último era de ayer" → an ISO date', () => {
    expect(extractLastRecordDateCorrection('el último era de ayer')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('"la última fue anteayer" → ISO', () => {
    expect(extractLastRecordDateCorrection('la última fue anteayer')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('does NOT fire on a new dated action "fumigué ayer"', () => {
    expect(extractLastRecordDateCorrection('fumigué ayer')).toBeNull();
  });
  it('null without a relative date', () => {
    expect(extractLastRecordDateCorrection('el último era en lote norte')).toBeNull();
  });
});
