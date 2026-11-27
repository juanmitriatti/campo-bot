// Entradas malas que corrompían datos (prueba del 27 nov 2026 contra Haiku 5.5).
// Cada caso manda EXACTAMENTE lo que mandó el modelo.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../pipeline-harness.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[bad-inputs] DB no disponible — suite salteada');
}

describe.skipIf(!dbAvailable)('entradas malas', () => {
  let h: PipelineHarness;
  let lote2: number;
  let lote3: number;
  const count = async (sql: string) => (await h.q(sql, [h.userId])).length;
  const events = () => h.q(`SELECT event_type, quantity::float AS q, unit FROM domain_events WHERE user_id = $1 AND deleted_at IS NULL AND event_type <> 'planting'`, [h.userId]);
  const yieldKg = async () => (await h.q(`SELECT yield_kg::float AS y FROM plot_crops WHERE plot_id = $1`, [lote2]))[0]?.y ?? null;
  const heads = async () => (await h.q(`SELECT COALESCE(SUM(count), 0)::int AS n FROM livestock_groups WHERE user_id = $1 AND deleted_at IS NULL`, [h.userId]))[0];
  const harvest = (kgPerHa: number) => h.fakeAgent.enqueueTool('harvest_crop', { crop: 'trigo', plot: '2', field: 'La Esperanza', yield_kg_per_ha: kgPerHa });

  beforeAll(async () => {
    h = await createPipelineHarness('entradas-malas');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Esperanza') RETURNING id`, [h.userId]);
    const fid = (f[0] as { id: number }).id;
    lote2 = ((await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, '2', 100) RETURNING id`, [fid]))[0] as { id: number }).id;
    lote3 = ((await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, '3', 80) RETURNING id`, [fid]))[0] as { id: number }).id;
  });
  afterAll(async () => { await h?.cleanup(); });
  beforeEach(async () => {
    h.fakeAgent.reset();
    await h.send('cancelar');
    for (const t of ['domain_events', 'expenses', 'livestock_movements', 'livestock_groups', 'expense_templates', 'task_reminders']) {
      await h.q(`DELETE FROM ${t} WHERE user_id = $1`, [h.userId]);
    }
    await h.q(`DELETE FROM plot_crops WHERE plot_id IN ($1, $2)`, [lote2, lote3]);
    await h.q(`INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date) VALUES ($1, 'trigo', 2026, 'fina', '2026-06-10')`, [lote2]);
  });

  it('un lote que no existe no se cambia por otro', async () => {
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: '22', field: 'La Esperanza' });
    const items = await h.send('sembre soja en el lote 22');
    const text = h.allText(items);
    expect(text).toMatch(/En qué lote/);
    expect(await count(`SELECT pc.id FROM plot_crops pc JOIN plots p ON p.id = pc.plot_id JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1 AND pc.crop = 'soja'`)).toBe(0);
    expect(h.allButtons(items).some(b => b.id.startsWith('sow_replace_') || b.id.startsWith('sow_after_harvest_'))).toBe(false);
  });

  it.each([
    ['compré 2,5 vacas para el lote 3', { count: 2 }],
    ['compré 1000000 de vacas para el lote 3', { count: 1, unit_price_ars: 1000000 }],
  ])('«%s» no inventa cabezas ni plata', async (msg, extra) => {
    h.fakeAgent.enqueueTool('add_livestock', { category: 'vaca', plot: '3', field: 'La Esperanza', is_purchase: true, ...extra });
    const text = h.allText(await h.send(msg));
    expect(text).toMatch(/Cuántas/i);
    expect(await heads()).toEqual({ n: 0 });
    expect(await count('SELECT id FROM expenses WHERE user_id = $1')).toBe(0);
  });

  it.each([
    ['compré treinta vacas y 20 terneros para el lote 3', 30, undefined],
    ['compré 500 vacas a 500 dólares cada una para el lote 3', 500, 500],
  ])('«%s» conserva la cantidad (y el precio)', async (msg, n, price) => {
    h.fakeAgent.enqueueTool('add_livestock', { category: 'vaca', plot: '3', field: 'La Esperanza', is_purchase: true, count: n, ...(price ? { unit_price_usd: price } : {}) });
    await h.send(msg);
    expect(await heads()).toEqual({ n });
    if (price) expect(await count('SELECT id FROM expenses WHERE user_id = $1')).toBe(1);
  });

  it('euros no se guardan como dólares', async () => {
    h.fakeAgent.enqueueTool('log_expense', { amount: 100, currency: 'USD', category: 'Maquinaria' });
    const text = h.allText(await h.send('gasté 100 euros en repuestos'));
    expect(text).toMatch(/pesos o d[oó]lares/i);
    expect(await count('SELECT id FROM expenses WHERE user_id = $1')).toBe(0);
  });

  it('un plan para el año que viene es un recordatorio, no un gasto mensual', async () => {
    h.fakeAgent.enqueueTool('create_expense_template', { name: 'gasoil', amount: 50000, category: 'Combustible', recurrence_type: 'monthly' });
    await h.send('el año que viene gasto 50 mil en gasoil');
    expect(await count('SELECT id FROM expense_templates WHERE user_id = $1')).toBe(0);
  });

  it('un gasto fijo pedido como tal se sigue creando', async () => {
    h.fakeAgent.enqueueTool('create_expense_template', { name: 'alquiler', amount: 50000, category: 'Arrendamiento', recurrence_type: 'monthly' });
    await h.send('el mes que viene arranco a pagar 50 mil de alquiler todos los meses');
    expect(await count('SELECT id FROM expense_templates WHERE user_id = $1')).toBe(1);
  });

  it('una fecha que no existe no se guarda con la de hoy', async () => {
    h.fakeAgent.enqueueTool('log_spraying', { plot: '2', product: 'glifosato', quantity: 2, unit: 'lt', event_date: '2026-02-31' });
    const text = h.allText(await h.send('el 31 de febrero fumigué el lote 2 con 2 lt de glifosato'));
    expect(text).toMatch(/no existe/i);
    expect(await events()).toEqual([]);
  });

  it('40 kg/ha pregunta; «40 qq/ha» guarda 400.000 kg', async () => {
    harvest(40);
    const items = await h.send('coseché el trigo del lote 2, rindió 40 kg/ha');
    expect(await yieldKg()).toBeNull();
    const qq = h.allButtons(items).find(b => b.title === 'Fueron 40 qq/ha')!;
    expect(qq).toBeTruthy();
    await h.tap(qq.id);
    expect(await yieldKg()).toBe(400000);
  });

  it('una dosis imposible de fumigación pregunta antes de guardar', async () => {
    h.fakeAgent.enqueueTool('log_spraying', { plot: '2', product: 'glifosato', quantity: 2, unit: 'tn/ha' });
    const items = await h.send('fumigué el lote 2 con 2 tn/ha de glifosato');
    expect(await events()).toEqual([]);
    await h.tap(h.allButtons(items).find(b => b.title === 'Sí, es correcto')!.id);
    expect(await events()).toEqual([{ event_type: 'spraying', q: 2, unit: 'tn/ha' }]);
  });

  it('una fertilización de a toneladas no pregunta', async () => {
    h.fakeAgent.enqueueTool('log_fertilization', { plot: '2', product: 'cal', quantity: 2, unit: 'tn/ha' });
    await h.send('encalé el lote 2 con 2 tn/ha de cal');
    expect(await events()).toHaveLength(1);
  });

  it('una autocorrección en un registro nuevo no cambia una siembra guardada', async () => {
    h.fakeAgent.enqueueTool('edit_last_activity', { new_crop: 'maíz', activity_filter: 'planting' });
    await h.q(`INSERT INTO domain_events (user_id, plot_id, event_type, crop, event_date) VALUES ($1, $2, 'planting', 'trigo', CURRENT_DATE)`, [h.userId, lote2]);
    const text = h.allText(await h.send('sembré soja, no, maíz, en el lote 2 o en el 3'));
    expect(text).toMatch(/No guardé nada/);
    expect(await h.q(`SELECT crop FROM domain_events WHERE user_id = $1`, [h.userId])).toEqual([{ crop: 'trigo' }]);
  });

  it('corregir un cultivo por el mismo cultivo lo dice', async () => {
    h.fakeAgent.enqueueTool('edit_last_activity', { new_crop: 'trigo', activity_filter: 'planting' });
    await h.q(`INSERT INTO domain_events (user_id, plot_id, event_type, crop, event_date) VALUES ($1, $2, 'planting', 'trigo', CURRENT_DATE)`, [h.userId, lote2]);
    const text = h.allText(await h.send('la siembra era trigo'));
    expect(text).toMatch(/no cambié nada/i);
  });
});
