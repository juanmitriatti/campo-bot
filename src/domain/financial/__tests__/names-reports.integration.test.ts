/**
 * Nombres, reportes y plata (auditoría oct 2026, tanda 9a: CAM-8/12/14,
 * FIN-19/20/21/22/23/25/27/28/30/41). Contra la DB real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../../testing/integration/pipeline-harness.js';
import { parseCommand } from '../../../utils/parser.js';
import {
  setFieldCity, getDateRangeReport, getGrainBalance, updateExpenseFields,
} from '../../../services/expenses.js';
import { FinancialService } from '../financial.service.js';
import { FinancialRepository } from '../financial.repository.js';
import { ExpenseTemplateService } from '../expense-template.service.js';
import type { UserId } from '../../../types/index.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe('parser: nombres de campo y gastos fijos', () => {
  it('CAM-8: nombres con punto, apóstrofe, guion y de 5 palabras conservan nombre y localidad', () => {
    expect(parseCommand('agregar campo Sta. Rosa en Junín')).toMatchObject({ fieldName: 'Sta. Rosa', city: 'Junín' });
    expect(parseCommand("agregar campo O'Higgins")).toMatchObject({ fieldName: "O'Higgins" });
    expect(parseCommand('agregar campo 3-4 en Pergamino')).toMatchObject({ fieldName: '3-4', city: 'Pergamino' });
    expect(parseCommand('agregar campo Los Tres Hermanos del Sur en Junín')).toMatchObject({ fieldName: 'Los Tres Hermanos del Sur', city: 'Junín' });
  });

  it('FIN-28: "borrar gasto fijo de internet" borra el gasto fijo, no un gasto común', () => {
    expect(parseCommand('borrar gasto fijo de internet')).toMatchObject({ command: 'delete_expense_template', name: 'internet' });
    expect(parseCommand('borrar gasto de gasoil')).toMatchObject({ command: 'delete_specific', filter: 'gasoil' });
  });

  it('FIN-23: el presupuesto entiende dólares', () => {
    expect(parseCommand('presupuesto de 2000 dólares para gasoil')).toMatchObject({ command: 'set_budget', amount: 2000, currency: 'USD' });
    expect(parseCommand('presupuesto de 300 mil para semillas')).toMatchObject({ command: 'set_budget', currency: 'ARS' });
  });
});

describe.skipIf(!dbAvailable)('nombres, reportes y plata', () => {
  let h: PipelineHarness;
  let userId: number;
  let seq = 0;
  const svc = new FinancialService(new FinancialRepository());

  const newField = async (name: string) => {
    const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, name]);
    await pool.query(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [f.rows[0].id, userId]);
    return f.rows[0].id as number;
  };
  const newPlot = async (fieldId: number, name: string) =>
    (await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, $2, 100) RETURNING id`, [fieldId, name])).rows[0].id as number;
  const expense = async (amount: number, category: string, currency = 'ARS', extra: Record<string, unknown> = {}) =>
    (await pool.query(
      `INSERT INTO expenses (user_id, amount, category, currency, expense_date, field_id, plot_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, $7, $8) RETURNING id`,
      [userId, amount, category, currency, extra.fieldId ?? null, extra.plotId ?? null, extra.quantity ?? null, extra.unitPrice ?? null],
    )).rows[0].id as number;

  beforeAll(async () => {
    h = await createPipelineHarness('names-reports');
    userId = Number(h.userId);
    await pool.query(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [userId]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM budgets WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM expense_templates WHERE user_id = $1`, [userId]);
    await h?.cleanup();
  });
  beforeEach(() => { seq++; h.fakeAgent.reset(); });

  it('FIN-22: la alerta de un presupuesto en pesos no suma los gastos en dólares', async () => {
    await svc.setBudget(userId as UserId, 'Fletes', 100_000, 'ARS');
    await expense(90_000, 'Fletes', 'ARS');
    await expense(30, 'Fletes', 'USD');
    const alert = await svc.checkBudgetAlert(userId as UserId, 'Fletes', null);
    expect(alert).toMatch(/Actual: \$90\.000/);
  });

  it('FIN-23: un presupuesto en dólares compara solo gastos en dólares y lo dice en dólares', async () => {
    await svc.setBudget(userId as UserId, 'Repuestos', 1_000, 'USD');
    await expense(950, 'Repuestos', 'USD');
    await expense(500_000, 'Repuestos', 'ARS');
    const alert = await svc.checkBudgetAlert(userId as UserId, 'Repuestos', null);
    expect(alert).toMatch(/US\$950/);
    expect(alert).toMatch(/US\$1\.000/);
  });

  it('CAM-12: con dos lotes del mismo nombre, la superficie pregunta de qué campo', async () => {
    const a = await newField(`Alfa ${seq}`);
    const b = await newField(`Beta ${seq}`);
    await newPlot(a, `Bajo ${seq}`);
    await newPlot(b, `Bajo ${seq}`);
    h.fakeAgent.enqueueTool('set_plot_area', { plot: `Bajo ${seq}`, hectares: 80 });
    const r = await h.send(`el lote Bajo ${seq} tiene 80 ha`);
    expect(h.allText(r)).toMatch(/¿De qué campo\?/);
    expect(h.allButtons(r).map((x) => x.title)).toEqual(expect.arrayContaining([`Alfa ${seq}`, `Beta ${seq}`]));
    const areas = await pool.query(`SELECT area_hectares::float AS ha FROM plots WHERE name = $1`, [`Bajo ${seq}`]);
    expect(areas.rows.every((x) => x.ha === 100)).toBe(true);
  });

  it('CAM-14: cambiar la localidad borra la provincia y las coordenadas de la anterior; el nombre con acento matchea', async () => {
    const fieldId = await newField(`La Peña ${seq}`);
    await pool.query(`UPDATE fields SET city = 'Pergamino', province = 'Buenos Aires', latitude = -33.89, longitude = -60.57 WHERE id = $1`, [fieldId]);
    expect(await setFieldCity(userId, `la pena ${seq}`, 'Rafaela', 'Santa Fe')).toBe(1);
    const f = (await pool.query(`SELECT city, province, latitude::float AS lat FROM fields WHERE id = $1`, [fieldId])).rows[0];
    expect(f.city).toBe('Rafaela');
    expect(f.province).toBe('Santa Fe');
    expect(f.lat).not.toBeCloseTo(-33.89, 1);
  });

  it('FIN-19: "era en dólares" corrige la moneda del último ingreso', async () => {
    await pool.query(
      `INSERT INTO incomes (user_id, amount, category, currency, income_date) VALUES ($1, 3000, 'Venta de hacienda', 'ARS', CURRENT_DATE)`,
      [userId],
    );
    h.fakeAgent.enqueueTool('edit_last_income', {});
    const out = h.allText(await h.send('el último ingreso era en dólares'));
    expect(out).toMatch(/Moneda: ARS → \*USD\*/);
    const row = (await pool.query(`SELECT currency FROM incomes WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [userId])).rows[0];
    expect(row.currency).toBe('USD');
  });

  it('FIN-19: un gasto con filtro "ingreso" se resuelve como ingreso', async () => {
    await pool.query(
      `INSERT INTO incomes (user_id, amount, category, currency, income_date) VALUES ($1, 5000, 'Venta de granos', 'ARS', CURRENT_DATE)`,
      [userId],
    );
    h.fakeAgent.enqueueTool('edit_last_expense', { category_filter: 'ingreso', new_amount: 6000 });
    const out = h.allText(await h.send('el ingreso eran 6000'));
    expect(out).not.toMatch(/no encontr/i);
    expect(out).toMatch(/Ingreso corregido/);
  });

  it('FIN-20: "el último gasto de gasoil" encuentra un gasto de Combustible', async () => {
    const id = await expense(12_345, 'Combustible');
    const row = await svc.findLastExpenseByCategory(userId as UserId, 'gasoil');
    expect(row?.id).toBe(id);
  });

  it('FIN-21: el reporte por lote matchea sin acentos ("la canada" → "La Cañada")', async () => {
    const fieldId = await newField(`Reporte ${seq}`);
    const plotId = await newPlot(fieldId, 'La Cañada');
    await expense(7_777, 'Semillas', 'ARS', { fieldId, plotId });
    const today = new Date().toISOString().slice(0, 10);
    const rep = await getDateRangeReport(userId, '2000-01-01', today, { plotName: 'la canada' });
    const total = JSON.stringify(rep);
    expect(total).toMatch(/7777/);
  });

  it('FIN-25: "Cargil" y "Cargill SA" son el mismo acopio en el saldo', async () => {
    await pool.query(
      `INSERT INTO incomes (user_id, amount, category, currency, income_date, buyer, quantity_kg) VALUES
         ($1, 1, 'Soja', 'ARS', CURRENT_DATE, 'Cargil', 10000),
         ($1, 1, 'Soja', 'ARS', CURRENT_DATE, 'Cargill SA', 5000)`,
      [userId],
    );
    const rows = (await getGrainBalance(userId, { crop: 'soja' })).filter((r) => /cargil/i.test(r.destinatario));
    expect(rows).toHaveLength(1);
    expect(rows[0].soldKg).toBe(15000);
  });

  it('FIN-27: un gasto fijo con un lote que no existe no se crea en silencio', async () => {
    h.fakeAgent.enqueueTool('create_expense_template', { name: 'Luz', amount: 20000, plot: 'Inexistente' });
    const out = h.allText(await h.send('gasto fijo mensual de luz 20 mil en el lote Inexistente'));
    expect(out).toMatch(/No encontré el lote/);
    const t = await pool.query(`SELECT 1 FROM expense_templates WHERE user_id = $1 AND name = 'Luz' AND active`, [userId]);
    expect(t.rows).toHaveLength(0);
  });

  it('FIN-30: corregir el monto recalcula el precio por unidad', async () => {
    const id = await expense(400_000, 'Fertilizantes', 'ARS', { quantity: 50, unitPrice: 8_000 });
    await updateExpenseFields(id, { amount: 500_000 });
    const row = (await pool.query(`SELECT unit_price::float AS up FROM expenses WHERE id = $1`, [id])).rows[0];
    expect(row.up).toBe(10_000);
  });

  it('FIN-41: borrar un gasto fijo por nombre parcial; sin categoría genera "Otros"', async () => {
    const templates = new ExpenseTemplateService();
    await templates.create(userId as UserId, { name: `Internet fibra ${seq}`, amount: 15000, recurrenceType: 'monthly', recurrenceDay: 1 } as never);
    expect(await templates.deleteByName(userId as UserId, 'internet')).toBe(true);
  });
});
