// La base rechaza lo imposible, venga de donde venga.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../pipeline-harness.js';
import { saveExpense } from '../../../services/expenses.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[db-sanity] DB no disponible — suite salteada');
}

describe.skipIf(!dbAvailable)('restricciones de cordura en la base', () => {
  let h: PipelineHarness;
  beforeAll(async () => { h = await createPipelineHarness('db-sanity'); });
  afterAll(async () => { await h?.cleanup(); });

  const insert = (amount: unknown, currency: string, date: string | null) => h.q(
    'INSERT INTO expenses (user_id, amount, currency, category, expense_date) VALUES ($1, $2, $3, $4, $5)',
    [h.userId, amount, currency, 'Otros', date]);

  it.each([
    ['moneda desconocida', 10, 'EUR', '2026-01-01'],
    ['monto negativo', -5, 'ARS', '2026-01-01'],
    ['monto vacío', null, 'ARS', '2026-01-01'],
    ['sin fecha', 10, 'ARS', null],
  ])('gasto con %s: rechazado', async (_n, amount, currency, date) => {
    await expect(insert(amount, currency as string, date as string | null)).rejects.toThrow(/chk_expenses/);
  });

  it('la moneda se normaliza al guardar y una desconocida se rechaza', async () => {
    const { id } = await saveExpense(h.userId, { amount: 10, currency: 'usd', category: 'Otros' });
    expect(await h.q('SELECT currency FROM expenses WHERE id = $1', [id])).toEqual([{ currency: 'USD' }]);
    await expect(saveExpense(h.userId, { amount: 10, currency: 'EUR', category: 'Otros' })).rejects.toThrow(/pesos o dólares/);
  });
});
