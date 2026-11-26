import { describe, it, expect } from 'vitest';
import { buildExpensePatch, type ExpenseFormState } from './expense-patch';

const base: ExpenseFormState = {
  description: 'flete', amount: 600000, currency: 'ARS', category: 'Otros', expenseDate: '2026-11-10',
  expenseType: 'varios', product: '', quantity: '30', unit: 'tn', unitPrice: '20000', plotId: '5', initialPlotId: '5',
};

describe('buildExpensePatch', () => {
  it('un gasto que NO es insumo conserva cantidad, unidad y precio por unidad al editar la fecha', () => {
    const p = buildExpensePatch({ ...base, expenseDate: '2026-11-12' });
    expect(p.quantity).toBe(30);
    expect(p.unit).toBe('tn');
    expect(p.unit_price).toBe(20000);
    expect(p.expense_date).toBe('2026-11-12');
  });

  it('un campo vacío se manda como null (se puede borrar a propósito)', () => {
    const p = buildExpensePatch({ ...base, quantity: '', unitPrice: '  ' });
    expect(p.quantity).toBeNull();
    expect(p.unit_price).toBeNull();
  });

  it('el lote solo viaja si cambió', () => {
    expect('plot_id' in buildExpensePatch(base)).toBe(false);
    expect(buildExpensePatch({ ...base, plotId: '' }).plot_id).toBeNull();
    expect(buildExpensePatch({ ...base, plotId: '9' }).plot_id).toBe(9);
  });
});

describe('buildExpensePatch con formato argentino', () => {
  it('"1.500,5" y "30,5" se leen como número, no se pierden', () => {
    const p = buildExpensePatch({ ...base, quantity: '1.500,5', unitPrice: '30,5' });
    expect(p.quantity).toBe(1500.5);
    expect(p.unit_price).toBe(30.5);
  });
});
