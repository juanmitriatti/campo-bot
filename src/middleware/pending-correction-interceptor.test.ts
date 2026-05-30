import { describe, it, expect } from 'vitest';
import { tryApplyPendingCorrection } from './pending-correction-interceptor.js';

describe('tryApplyPendingCorrection', () => {
  it('returns applied:false when there is no pending', () => {
    expect(tryApplyPendingCorrection('no, era en sueldos', undefined).applied).toBe(false);
  });

  it('returns applied:false when pending is not expense/income', () => {
    expect(
      tryApplyPendingCorrection('no, era en sueldos', { type: 'activity' }).applied,
    ).toBe(false);
  });

  it('returns applied:false when text is not a correction', () => {
    expect(
      tryApplyPendingCorrection('cuánto llovió', { type: 'expense', data: {} }).applied,
    ).toBe(false);
  });

  it('patches the category on a category correction', () => {
    const r = tryApplyPendingCorrection('no, era en sueldos', {
      type: 'expense',
      data: { category: 'Otros', amount: 1000, currency: 'ARS' },
    });
    expect(r.applied).toBe(true);
    // detectarCategoria('sueldos') → 'Sueldos'
    expect((r.updatedPending!.data as Record<string, unknown>).category).toBe('Sueldos');
    expect(r.buttons?.some(b => b.id === 'confirm_pending')).toBe(true);
  });

  it('patches the amount on an amount correction', () => {
    const r = tryApplyPendingCorrection('no, eran 75000', {
      type: 'expense',
      data: { category: 'Gasoil', amount: 50000, currency: 'ARS' },
    });
    expect(r.applied).toBe(true);
    expect((r.updatedPending!.data as Record<string, unknown>).amount).toBe(75000);
    expect(r.body).toContain('💸');
  });

  it('patches category when only category correction fires', () => {
    // Note: extractCategoryCorrection and extractAmountCorrection each match on
    // their own distinct patterns — a single phrase rarely fires both.
    // Verify that a category-only correction leaves amount unchanged.
    const r = tryApplyPendingCorrection('no, era en gasoil', {
      type: 'expense',
      data: { category: 'Otros', amount: 50000, currency: 'ARS' },
    });
    expect(r.applied).toBe(true);
    const data = r.updatedPending!.data as Record<string, unknown>;
    expect(typeof data.category).toBe('string');
    // Amount should be unchanged
    expect(data.amount).toBe(50000);
  });

  it('uses income canonicalization for income type', () => {
    const r = tryApplyPendingCorrection('no, era en sueldos', {
      type: 'income',
      data: { category: 'Otros', amount: 100000, currency: 'ARS' },
    });
    expect(r.applied).toBe(true);
    expect(r.body).toContain('💰');
  });

  it('includes plotName in body when plotName is set', () => {
    const r = tryApplyPendingCorrection('no, era en sueldos', {
      type: 'expense',
      data: { category: 'Otros', amount: 1000, currency: 'ARS' },
      plotName: 'Norte',
      fieldName: 'La Esperanza',
    });
    expect(r.applied).toBe(true);
    expect(r.body).toContain('Lote Norte (La Esperanza)');
  });
});
