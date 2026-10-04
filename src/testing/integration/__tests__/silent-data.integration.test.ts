/**
 * Datos silenciosos — finanzas (auditoría oct 2026, tanda 3). Pipeline completo
 * con FakeAgent contra la DB real. Cada caso guardaba un dato equivocado que el
 * usuario no veía.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../pipeline-harness.js';
import { conversationLockStore } from '../../../middleware/conversation-lock-store.js';

let dbAvailable = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;
try {
  pool = (await import('../../../config/db.js')).pool;
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

const yesterdayAR = () =>
  new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

describe.skipIf(!dbAvailable)('datos silenciosos — finanzas', () => {
  let h: PipelineHarness;
  let fid: number;

  const lastExpense = async () =>
    (await h.q(`SELECT e.*, p.name AS plot_name FROM expenses e LEFT JOIN plots p ON p.id = e.plot_id
                 WHERE e.user_id = $1 AND e.deleted_at IS NULL ORDER BY e.id DESC LIMIT 1`, [h.userId]))[0] as Record<string, unknown>;
  const lastIncome = async () =>
    (await h.q(`SELECT * FROM incomes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [h.userId]))[0] as Record<string, unknown>;

  beforeAll(async () => {
    h = await createPipelineHarness('silent-data-fin');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'El Rincón') RETURNING id`, [h.userId]);
    fid = (f[0] as { id: number }).id;
    await h.q(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [fid, h.userId]);
    await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100), ($1, 'Sur', 80)`, [fid]);
    const { CategoryRepository } = await import('../../../domain/financial/category.repository.js');
    const { CategoryService } = await import('../../../domain/financial/category.service.js');
    const cs = new CategoryService(new CategoryRepository());
    await cs.bootstrapDefaults(Number(h.userId), 'income');
    await cs.bootstrapDefaults(Number(h.userId), 'expense');
  });
  afterAll(async () => h?.cleanup());
  beforeEach(async () => {
    await h.send('cancelar');
    // Cada caso arranca sin el lock conversacional que deja el anterior.
    conversationLockStore.clear(h.phone);
    await h.q(`UPDATE user_settings SET confirm_before_save = true WHERE user_id = $1`, [h.userId]);
  });

  it('FIN-1: "no, era en el Sur" con la tarjeta abierta guarda en el Sur', async () => {
    h.fakeAgent.enqueueTool('log_expense', { amount: 50000, category: 'Combustible', description: 'gasoil', plot: 'Norte', field: 'El Rincón' });
    await h.send('gasté 50 mil de gasoil en el Norte');
    const corr = h.allText(await h.send('no, era en el Sur'));
    expect(corr).toMatch(/Sur/);
    await h.tap('confirm_pending');
    expect((await lastExpense()).plot_name).toBe('Sur');
  });

  it('FIN-2: "no, era en dólares" cambia la moneda, NO la categoría', async () => {
    h.fakeAgent.enqueueTool('log_expense', { amount: 500, category: 'Combustible', description: 'gasoil', plot: 'Norte', field: 'El Rincón' });
    await h.send('gasté 500 de gasoil en el Norte');
    await h.send('no, era en dólares');
    await h.tap('confirm_pending');
    const e = await lastExpense();
    expect(e.currency).toBe('USD');
    expect(String(e.category)).toMatch(/combustible/i);
  });

  it('FIN-2: "no, es de ayer" cambia la fecha, NO la categoría', async () => {
    h.fakeAgent.enqueueTool('log_expense', { amount: 70000, category: 'Combustible', description: 'gasoil', plot: 'Norte', field: 'El Rincón' });
    await h.send('gasté 70 mil de gasoil en el Norte');
    await h.send('no, es de ayer');
    await h.tap('confirm_pending');
    const e = await lastExpense();
    expect(String(e.category)).toMatch(/combustible/i);
    expect(new Date(e.expense_date as string).toLocaleDateString('en-CA', { timeZone: 'UTC' })).toBe(yesterdayAR());
  });

  it('FIN-17: "no, eran 80" sobre $50.000 pregunta [$80] [$80.000]', async () => {
    h.fakeAgent.enqueueTool('log_expense', { amount: 50000, category: 'Combustible', description: 'gasoil', plot: 'Norte', field: 'El Rincón' });
    await h.send('gasté 50 mil de gasoil en el Norte');
    const ask = await h.send('no, eran 80');
    const ids = h.allButtons(ask).map(b => b.title);
    expect(ids.join(' ')).toMatch(/\$80\b/);
    expect(ids.join(' ')).toMatch(/\$80\.000/);
  });

  it('FIN-6: gasto parcial "ayer cargué gasoil" + "50 mil" conserva la fecha de ayer', async () => {
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    h.fakeAgent.enqueueTool('log_expense', { category: 'Combustible', description: 'gasoil', plot: 'Norte', field: 'El Rincón', event_date: yesterdayAR() });
    await h.send('ayer cargué gasoil en el Norte');
    await h.send('50 mil');
    const e = await lastExpense();
    expect(Number(e.amount)).toBe(50000);
    expect(new Date(e.expense_date as string).toLocaleDateString('en-CA', { timeZone: 'UTC' })).toBe(yesterdayAR());
  });

  it('FIN-5: venta de 30 tn + "a 400 mil la tonelada" = $12.000.000', async () => {
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    h.fakeAgent.enqueueTool('log_income', { category: 'Soja', quantity: 30, unit: 'tn', plot: 'Norte', field: 'El Rincón' });
    await h.send('vendí 30 tn de soja del Norte');
    await h.send('a 400 mil la tonelada');
    expect(Number((await lastIncome()).amount)).toBe(12000000);
  });

  it('FIN-14: "u$s 500" en un gasto parcial queda en dólares', async () => {
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    h.fakeAgent.enqueueTool('log_expense', { category: 'Combustible', description: 'gasoil importado', plot: 'Norte', field: 'El Rincón' });
    await h.send('compré gasoil importado para el Norte');
    await h.send('u$s 500');
    const e = await lastExpense();
    expect(e.currency).toBe('USD');
    expect(Number(e.amount)).toBe(500);
  });

  it('FIN-26: un guion en el texto no vuelve negativo el monto', async () => {
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    h.fakeAgent.enqueueTool('log_expense', { amount: 50000, category: 'Combustible', description: 'gasoil', plot: 'Norte', field: 'El Rincón' });
    const text = h.allText(await h.send('gasoil - 50 mil en el Norte'));
    expect(text).not.toMatch(/negativ/i);
    expect(Number((await lastExpense()).amount)).toBe(50000);
  });

  it('FIN-8: una categoría propia del usuario ("Fletes") no se pisa por Otros', async () => {
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    await h.q(`INSERT INTO user_categories (user_id, name, kind) VALUES ($1, 'Fletes', 'expense') ON CONFLICT DO NOTHING`, [h.userId]);
    h.fakeAgent.enqueueTool('log_expense', { amount: 90000, category: 'Fletes', category_match: 'exact', description: 'flete del maíz', plot: 'Norte', field: 'El Rincón' });
    await h.send('pagué 90 mil de flete del maíz en el Norte');
    expect((await lastExpense()).category).toBe('Fletes');
  });

  it('FIN-17: el tap [$80.000] corrige el monto y la tarjeta se confirma con ese valor', async () => {
    h.fakeAgent.enqueueTool('log_expense', { amount: 50000, category: 'Combustible', description: 'gasoil', plot: 'Norte', field: 'El Rincón' });
    await h.send('gasté 50 mil de gasoil en el Norte');
    await h.send('no, eran 80');
    await h.tap('pcorr_amt_80000');
    await h.tap('confirm_pending');
    expect(Number((await lastExpense()).amount)).toBe(80000);
  });

  it('FIN-10: "borrá el último gasto de gasoil" muestra y borra ESE gasto', async () => {
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    h.fakeAgent.enqueueTool('log_expense', { amount: 41000, category: 'Combustible', description: 'gasoil', plot: 'Norte', field: 'El Rincón' });
    await h.send('gasté 41 mil de gasoil en el Norte');
    h.fakeAgent.enqueueTool('log_expense', { amount: 30000, category: 'Semillas', description: 'semilla', plot: 'Norte', field: 'El Rincón' });
    await h.send('gasté 30 mil en semillas en el Norte');
    h.fakeAgent.enqueueTool('delete_last_expense', { category_filter: 'gasoil' });
    const ask = h.allText(await h.send('borrá el último gasto de gasoil'));
    expect(ask).toMatch(/Combustible \$41\.000/);
    await h.tap('confirm_destructive_delete_last_expense');
    const alive = await h.q(`SELECT amount FROM expenses WHERE user_id = $1 AND deleted_at IS NULL AND amount IN (41000, 30000)`, [h.userId]);
    expect(alive.map(r => Number(r.amount))).toEqual([30000]);
  });

  it('FIN-3: una venta con unidad que pasa por el flow de lote conserva su unidad, no tn', async () => {
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    h.fakeAgent.enqueueTool('log_income', { amount: 1500000, category: 'Otros', quantity: 20, unit: 'cabezas', plot: 'Oeste', field: 'El Rincón' });
    // Sin lote reciente en el contexto pregunta con el flow; con uno, lo hereda y
    // guarda directo. En los dos caminos la unidad tiene que ser la del mensaje.
    const first = await h.send('vendí 20 cabezas del lote Oeste por 1,5 palos');
    if (h.allButtons(first).some(b => b.id === 'flow_plot_norte')) {
      expect(h.allText(await h.tap('flow_plot_norte'))).toMatch(/Cantidad: \*20 cabezas\*/);
      await h.tap('flow_confirm');
    }
    const inc = await lastIncome();
    expect(inc.unit).toBe('cabezas');
    expect(Number(inc.quantity)).toBe(20);
  });

  it('FIN-16: una venta "a fijar" se puede fijar después (monto = cantidad × precio)', async () => {
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    h.fakeAgent.enqueueTool('log_income', { category: 'Soja', quantity: 30, unit: 'tn', buyer: 'Cargill', price_status: 'a_fijar', currency: 'USD', field: 'El Rincón' });
    await h.send('entregué 30 tn de soja a Cargill a fijar');
    h.fakeAgent.enqueueTool('edit_last_income', { new_unit_price: 300 });
    await h.send('fijé la soja de Cargill a 300 dólares la tonelada');
    const inc = await lastIncome();
    expect(inc.price_status).toBe('fijado');
    expect(Number(inc.amount)).toBe(9000);
  });

  it('CONV-10: "ayer fumigué … y hoy sembré …" deja cada actividad en su día', async () => {
    h.fakeAgent.enqueue([
      { toolName: 'log_spraying', toolInput: { plot: 'Norte', field: 'El Rincón', product: 'glifosato', event_date: yesterdayAR() } },
      { toolName: 'sow_crop', toolInput: { plot: 'Sur', field: 'El Rincón', crop: 'soja', event_date: yesterdayAR() } },
    ]);
    await h.send('ayer fumigué el Norte con glifosato y hoy sembré soja en el Sur');
    const sow = await h.q(
      `SELECT event_date::text AS d FROM domain_events WHERE user_id = $1 AND event_type = 'planting' ORDER BY id DESC LIMIT 1`, [h.userId]);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    expect((sow[0] as { d: string }).d).toBe(today);
  });

  it('FIN-40: un gasto con fecha futura avisa', async () => {
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    h.fakeAgent.enqueueTool('log_expense', { amount: 30000, category: 'Combustible', description: 'gasoil', plot: 'Norte', field: 'El Rincón', event_date: future });
    const text = h.allText(await h.send('gasté 30 mil de gasoil en el Norte'));
    expect(text).toMatch(/fecha.*futur|futur.*fecha/i);
  });
});
