// Todo borrado muestra el registro exacto y borra ESE.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../pipeline-harness.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[delete-preview] DB no disponible — suite salteada');
}

describe.skipIf(!dbAvailable)('borrados con vista previa', () => {
  let h: PipelineHarness;
  const expense = (amount: number, category: string, ago = 0) => h.q(
    `INSERT INTO expenses (user_id, amount, currency, category, expense_date, created_at)
     VALUES ($1, $2, 'ARS', $3, CURRENT_DATE, NOW() - make_interval(mins => $4::int))`, [h.userId, amount, category, ago]);
  const income = (amount: number, category: string, ago = 0) => h.q(
    `INSERT INTO incomes (user_id, amount, currency, category, income_date, created_at)
     VALUES ($1, $2, 'ARS', $3, CURRENT_DATE, NOW() - make_interval(mins => $4::int))`, [h.userId, amount, category, ago]);
  const live = async (table: 'expenses' | 'incomes') => (await h.q(
    `SELECT amount::float AS a FROM ${table} WHERE user_id = $1 AND deleted_at IS NULL ORDER BY amount`, [h.userId])).map(r => (r as { a: number }).a);

  beforeAll(async () => { h = await createPipelineHarness('borrados'); });
  afterAll(async () => { await h?.cleanup(); });
  beforeEach(async () => {
    h.fakeAgent.reset();
    await h.send('cancelar');
    await h.q(`DELETE FROM expenses WHERE user_id = $1`, [h.userId]);
    await h.q(`DELETE FROM incomes WHERE user_id = $1`, [h.userId]);
  });

  it('«borrá el gasto de 50 mil» muestra cuál antes de borrar', async () => {
    await expense(50000, 'Combustible', 5);
    await expense(900, 'Otros');
    h.fakeAgent.enqueueTool('delete_specific_expense', { filter_amount: 50000 });
    const items = await h.send('borrá el gasto de 50 mil');
    expect(h.allText(items)).toMatch(/Combustible \$50\.000/);
    await h.tap('confirm_destructive_delete_specific_expense');
    expect(await live('expenses')).toEqual([900]);
  });

  it('«borrá la última venta de soja» no borra un ingreso de otra cosa', async () => {
    await income(1000, 'Soja', 10);
    await income(2000, 'Hacienda');
    h.fakeAgent.enqueueTool('delete_last_income', {});
    const items = await h.send('borrá la última venta de soja');
    expect(h.allText(items)).toMatch(/Soja \$1\.000/);
    await h.tap(h.allButtons(items)[0].id);
    expect(await live('incomes')).toEqual([2000]);
  });

  it('si el último cambió entre la pregunta y el «Confirmar», vuelve a preguntar', async () => {
    await expense(100, 'Otros', 10);
    h.fakeAgent.enqueueTool('delete_last_expense', {});
    const first = await h.send('borrá el último gasto');
    const confirm = h.allButtons(first)[0].id;
    await expense(200, 'Otros');
    const again = await h.tap(confirm);
    expect(h.allText(again)).toMatch(/cambió/);
    expect(await live('expenses')).toEqual([100, 200]);
    await h.tap(confirm);
    expect(await live('expenses')).toEqual([100]);
  });

  it('«Deshacer» recupera el gasto borrado, una vez', async () => {
    await expense(300, 'Otros');
    h.fakeAgent.enqueueTool('delete_last_expense', {});
    const items = await h.send('borrá el último gasto');
    const done = await h.tap(h.allButtons(items)[0].id);
    expect(await live('expenses')).toEqual([]);
    const undo = h.allButtons(done).find(b => b.title === 'Deshacer')!;
    expect(h.allText(await h.tap(undo.id))).toMatch(/recuperé/);
    expect(await live('expenses')).toEqual([300]);
    expect(h.allText(await h.tap(undo.id))).toMatch(/ya estaba/);
  });

  it('«deshacé eso» de hacienda muestra el movimiento y no toca nada sin confirmar', async () => {
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Posta') RETURNING id`, [h.userId]);
    await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Uno')`, [(f[0] as { id: number }).id]);
    h.fakeAgent.enqueueTool('add_livestock', { category: 'vaca', count: 4, plot: 'Uno' });
    await h.send('tengo 4 vacas en el Uno');
    const heads = async () => (await h.q(`SELECT COALESCE(SUM(count), 0)::int AS n FROM livestock_groups WHERE user_id = $1 AND deleted_at IS NULL`, [h.userId]))[0];
    h.fakeAgent.enqueueTool('revert_livestock_movement', {});
    const items = await h.send('deshacé eso');
    expect(h.allText(items)).toMatch(/Ingreso de 4 vaca/);
    expect(await heads()).toEqual({ n: 4 });
    await h.tap(h.allButtons(items)[0].id);
    expect(await heads()).toEqual({ n: 0 });
  });

  it('borrar camiones: confirma, y solo toca la campaña de la última cosecha', async () => {
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'El Silo') RETURNING id`, [h.userId]);
    const p = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Camiones', 100) RETURNING id`, [(f[0] as { id: number }).id]);
    const plotId = (p[0] as { id: number }).id;
    for (const [crop, season, date, driver] of [['soja', 2025, '2026-04-01', 'Viejo'], ['maiz', 2026, '2026-11-01', 'Nuevo']] as const) {
      const pc = await h.q(`INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, end_date, harvested_at)
        VALUES ($1, $2, $3, 'gruesa', $4, $4, $4) RETURNING id`, [plotId, crop, season, date]);
      const pcId = (pc[0] as { id: number }).id;
      const ev = await h.q(`INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, crop, event_date)
        VALUES ($1, $2, $3, 'harvest', $4, $5) RETURNING id`, [h.userId, plotId, pcId, crop, date]);
      await h.q(`INSERT INTO harvest_loads (domain_event_id, plot_crop_id, driver_name, weight_kg) VALUES ($1, $2, $3, 28000)`,
        [(ev[0] as { id: number }).id, pcId, driver]);
    }
    const drivers = async () => (await h.q(
      `SELECT hl.driver_name AS d FROM harvest_loads hl JOIN domain_events de ON de.id = hl.domain_event_id WHERE de.plot_id = $1 ORDER BY 1`, [plotId]))
      .map(r => (r as { d: string }).d);
    h.fakeAgent.enqueueTool('delete_harvest_loads', { plot: 'Camiones' });
    const items = await h.send('esos camiones del lote Camiones están de más');
    expect(h.allText(items)).toMatch(/1 camión de Camiones/);
    expect(await drivers()).toEqual(['Nuevo', 'Viejo']);
    await h.tap(h.allButtons(items)[0].id);
    expect(await drivers()).toEqual(['Viejo']);
  });

  it('un borrado dentro de un mensaje con varias acciones no se ejecuta sin confirmar', async () => {
    await expense(400, 'Otros');
    h.fakeAgent.enqueue([
      { toolName: 'delete_last_expense', toolInput: {} },
      { toolName: 'log_expense', toolInput: { amount: 500, category: 'Otros' } },
    ]);
    const items = await h.send('borrá el último gasto y gasté 500 en varios');
    expect(await live('expenses')).toEqual([400, 500]);
    expect(h.allText(items)).toMatch(/en un mensaje aparte/);
  });

  it('sin nada que coincida no pide confirmación', async () => {
    h.fakeAgent.enqueueTool('delete_specific_expense', { filter_amount: 7 });
    const items = await h.send('borrá el gasto de 7 pesos');
    expect(h.allButtons(items).some(b => b.id.startsWith('confirm_destructive'))).toBe(false);
    expect(h.allText(items)).toMatch(/No encontré/);
  });
});
