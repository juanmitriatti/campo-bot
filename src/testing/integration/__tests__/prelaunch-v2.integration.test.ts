// Los cinco arreglos de código de la revisión v2 antes de abrir (27 nov 2026).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../pipeline-harness.js';
import { pendingActStore } from '../../../services/message-pipeline.js';
import { submitForm } from '../../../forms/form-submit.service.js';
import { formSessionService } from '../../../services/form-session.service.js';
import { setSetting } from '../../../services/settings.service.js';
import { getTodayISO } from '../../../utils/date.js';
import type { FormAction } from '../../../forms/form-definitions.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[prelaunch-v2] DB no disponible — suite salteada');
}

describe.skipIf(!dbAvailable)('revisión v2: precio de hacienda y duplicados del formulario', () => {
  let h: PipelineHarness;
  let norte: number;
  let sur: number;

  const herds = async () => (await h.q(
    `SELECT p.name AS plot, g.category::text AS c, g.count::int AS n FROM livestock_groups g JOIN plots p ON p.id = g.plot_id
      WHERE g.user_id = $1 AND g.count > 0 AND g.deleted_at IS NULL ORDER BY 1, 2`, [h.userId]))
    .map(r => `${(r as { plot: string }).plot}:${(r as { c: string }).c}:${(r as { n: number }).n}`);
  const expenses = async () => (await h.q(
    `SELECT amount::float AS a, plot_id FROM expenses WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id`, [h.userId]));
  const buy = async () => {
    h.fakeAgent.enqueueTool('add_livestock', { category: 'vaca', count: 20, plot: 'Norte', is_purchase: true });
    await h.send('compré 20 vacas en el Norte');
    expect(pendingActStore.get(h.phone)?.command).toBe('set_livestock_price');
  };
  const open = (action: FormAction) => formSessionService.create({
    userId: h.userId, action, prefill: {}, channel: 'testbot', channelId: 'x', phone: h.phone, hadPending: false,
  });
  const expensePayload = (plot: number, amount = '50000') => ({
    amount, currency: 'ARS', category: 'Otros', location: `p:${plot}`, event_date: getTodayISO(),
  });
  const chatExpense = (plot: number, amount: number) => h.q(
    `INSERT INTO expenses (user_id, amount, currency, category, plot_id, expense_date) VALUES ($1, $2, 'ARS', 'Otros', $3, $4)`,
    [h.userId, amount, plot, getTodayISO()]);

  beforeAll(async () => {
    h = await createPipelineHarness('prelaunch-v2', { channel: 'whatsapp' });
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'los pinos') RETURNING id`, [h.userId]);
    const fid = (f[0] as { id: number }).id;
    norte = ((await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100) RETURNING id`, [fid]))[0] as { id: number }).id;
    sur = ((await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Sur', 80) RETURNING id`, [fid]))[0] as { id: number }).id;
  });
  afterAll(async () => {
    await setSetting('WHATSAPP_FORM_PROVIDER', 'conversation');
    await setSetting('WHATSAPP_FLOW_ID_LIVESTOCK', '');
    await h?.cleanup();
  });
  beforeEach(async () => {
    h.fakeAgent.reset();
    await h.send('cancelar');
    pendingActStore.clear(h.phone);
    for (const t of ['expenses', 'livestock_movements', 'livestock_groups']) await h.q(`DELETE FROM ${t} WHERE user_id = $1`, [h.userId]);
  });

  it('3: al cambiar de tema avisa que la compra quedó sin precio', async () => {
    await buy();
    h.fakeAgent.enqueueTool('add_livestock', { category: 'toro', count: 7, plot: 'Sur' });
    const text = h.allText(await h.send('tengo 7 toros en el Sur'));
    expect(text).toMatch(/sin precio\* la compra de 20 vaca/i);
    expect(await herds()).toEqual(['Norte:vaca:20', 'Sur:toro:7']);
  });

  it.each(['7 vacas en el Sur', 'son 7 vacas en el Sur'])('6: «%s» es un alta nueva, no cambia la compra anterior', async (msg) => {
    await buy();
    h.fakeAgent.enqueueTool('add_livestock', { category: 'vaca', count: 7, plot: 'Sur' });
    await h.send(msg);
    expect(await herds()).toEqual(['Norte:vaca:20', 'Sur:vaca:7']);
    expect(await expenses()).toEqual([]);
  });

  it.each(['no, eran 1800', 'no, 2000'])('7: «%s» es el precio, no la cantidad', async (msg) => {
    await buy();
    h.fakeAgent.enqueueTool('set_livestock_price', { unit_price_ars: Number(msg.match(/\d+/)![0]), kind: 'expense' });
    await h.send(msg);
    expect(await herds()).toEqual(['Norte:vaca:20']);
    expect((await expenses()).map(r => (r as { a: number }).a)).toEqual([20 * Number(msg.match(/\d+/)![0])]);
  });

  it('7: «no, eran 8» sigue corrigiendo la cantidad', async () => {
    await buy();
    await h.send('no, eran 8');
    expect(await herds()).toEqual(['Norte:vaca:8']);
  });

  it('4: el mismo gasto en OTRO lote no bloquea el formulario', async () => {
    const token = await open('log_expense');
    await chatExpense(sur, 50000);
    const r = await submitForm(token, expensePayload(norte), { deliver: 'return' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await expenses()).toHaveLength(2);
  });

  it.each([['igual', 50000], ['con el monto cambiado', 55000]])('4: un posible duplicado %s pregunta, no descarta', async (_n, amount) => {
    const token = await open('log_expense');
    await chatExpense(norte, amount as number);
    const r = await submitForm(token, expensePayload(norte), { deliver: 'return' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await expenses()).toHaveLength(1);
    const buttons = r.ok && r.response?.interactive?.type === 'buttons' ? r.response.interactive.buttons : [];
    expect(buttons.map(b => b.title)).toEqual(['Guardar igual', 'No, ya está']);
    await h.tap(buttons[0].id);
    expect(await expenses()).toHaveLength(2);
  });

  it('5: lote de hacienda contestado a medias + formulario: la pregunta no vuelve a cargar', async () => {
    await setSetting('WHATSAPP_FORM_PROVIDER', 'meta_flow');
    await setSetting('WHATSAPP_FLOW_ID_LIVESTOCK', 'flow_liv_test');
    h.fakeAgent.enqueue([
      { toolName: 'add_livestock', toolInput: { category: 'vaca', count: 3, is_purchase: true } },
      { toolName: 'add_livestock', toolInput: { category: 'ternero', count: 5, is_purchase: true } },
    ]);
    const items = await h.send('compre 3 vacas y 5 terneros') as unknown as Array<{ interactive?: { type: string; flow?: { flowToken: string } } }>;
    const token = items.find(i => i.interactive?.type === 'flow')!.interactive!.flow!.flowToken;
    await h.send('Norte');
    const r = await submitForm(token, {
      origin: 'compra', location: `p:${norte}`, event_date: getTodayISO(), currency: 'ARS', category: 'vaca', count: '3', price_mode: 'head',
      animals_add_1: ['si'], animals_1_category: 'ternero', animals_1_count: '5', animals_1_price_mode: 'head',
    }, { flowResponse: true, deliver: 'return' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await herds()).toEqual(['Norte:ternero:5', 'Norte:vaca:3']);
    const after = pendingActStore.get(h.phone);
    const asking = [after, ...(after?.nextInQueue ?? [])].filter(p => p?.command === 'add_livestock');
    expect(asking).toEqual([]);
  });
});
