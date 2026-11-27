// «gasté 200 litros» pregunta si se compraron o se usaron; el gasto que el cron
// guarda al vencer la pregunta se puede deshacer.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../pipeline-harness.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[stock-direction-undo] DB no disponible — suite salteada');
}

describe.skipIf(!dbAvailable)('stock ambiguo y deshacer el gasto vencido', () => {
  let h: PipelineHarness;
  const stock = async () => (await h.q(
    `SELECT current_quantity::float AS q FROM stock_items WHERE user_id = $1 AND LOWER(name) = 'gasoil'`, [h.userId]))
    .map(r => (r as { q: number }).q);
  const liveExpenses = async () => (await h.q(`SELECT amount::float AS a FROM expenses WHERE user_id = $1 AND deleted_at IS NULL`, [h.userId]))
    .map(r => (r as { a: number }).a);
  const addStock = () => h.fakeAgent.enqueueTool('add_stock', { product: 'gasoil', quantity: 200, unit: 'lt', field: 'El Sauce' });

  beforeAll(async () => {
    h = await createPipelineHarness('stock-direccion');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'El Sauce') RETURNING id`, [h.userId]);
    const fid = (f[0] as { id: number }).id;
    await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Uno')`, [fid]);
    await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Dos')`, [fid]);
  });
  afterAll(async () => { await h?.cleanup(); });
  beforeEach(async () => {
    h.fakeAgent.reset();
    await h.send('cancelar');
    await h.q(`DELETE FROM stock_movements WHERE user_id = $1`, [h.userId]);
    await h.q(`DELETE FROM stock_items WHERE user_id = $1`, [h.userId]);
    await h.q(`DELETE FROM expenses WHERE user_id = $1`, [h.userId]);
  });

  it('«gasté 200 litros» no toca el stock y pregunta; [Los compré] lo carga', async () => {
    addStock();
    const items = await h.send('gasté 200 litros en gasoil');
    expect(await stock()).toEqual([]);
    expect(h.allButtons(items).map(b => b.title)).toEqual(['Los compré', 'Los usé', 'Cancelar']);
    await h.tap(h.allButtons(items)[0].id);
    expect(await stock()).toEqual([200]);
    // El otro botón del mismo teclado ya no hace nada.
    await h.tap(h.allButtons(items)[1].id);
    expect(await stock()).toEqual([200]);
  });

  it('[Los usé] descuenta del stock que había', async () => {
    addStock();
    await h.send('compré 500 litros de gasoil');
    expect(await stock()).toEqual([200]);
    addStock();
    const items = await h.send('gasté 200 litros en gasoil');
    expect(await stock()).toEqual([200]);
    await h.tap(h.allButtons(items).find(b => b.title === 'Los usé')!.id);
    expect(await stock()).toEqual([0]);
  });

  it('una compra se carga sin preguntar', async () => {
    addStock();
    await h.send('compré 200 litros de gasoil');
    expect(await stock()).toEqual([200]);
  });

  it('gasto vencido que guarda el cron: trae «Deshacer» y funciona una sola vez', async () => {
    const { closeExpiredFlow } = await import('../../../services/scheduler.js');
    h.fakeAgent.enqueueTool('log_expense', { amount: 7000, category: 'Otros', description: 'varios' });
    await h.send('gasté 7000 en varios');
    await h.q(`UPDATE conversation_state SET flow_expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, [h.userId]);
    const closed = await closeExpiredFlow({ userId: h.userId, phone: h.phone, telegramId: null }, Date.now());
    expect(await liveExpenses()).toEqual([7000]);
    expect(closed.buttons?.map(b => b.title)).toEqual(['Deshacer']);
    const text = h.allText(await h.tap(closed.buttons![0].id));
    expect(text).toMatch(/borré/i);
    expect(await liveExpenses()).toEqual([]);
    expect(h.allText(await h.tap(closed.buttons![0].id))).toMatch(/ya no está/i);
  });

  it('un «Deshacer» de otro usuario no borra nada', async () => {
    const other = await createPipelineHarness('stock-direccion-otro');
    const rows = await other.q(`INSERT INTO expenses (user_id, amount, currency, category) VALUES ($1, 10, 'ARS', 'Otros') RETURNING id`, [other.userId]);
    await h.tap(`undo_auto_expense_${(rows[0] as { id: number }).id}`);
    expect((await other.q(`SELECT id FROM expenses WHERE user_id = $1 AND deleted_at IS NULL`, [other.userId])).length).toBe(1);
    await other.cleanup();
  });
});
