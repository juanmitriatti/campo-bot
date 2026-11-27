// Con "¿a cuánto fue la compra?" abierta: un alta nueva no es el precio, un
// número pelado no corrige la cantidad y «Sin precio» cierra la pregunta.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../pipeline-harness.js';
import { pendingActStore } from '../../../services/message-pipeline.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[livestock-price-pending] DB no disponible — suite salteada');
}

describe.skipIf(!dbAvailable)('pregunta de precio de hacienda abierta', () => {
  let h: PipelineHarness;
  const groups = async () => (await h.q(
    `SELECT p.name AS plot, g.count::int AS n FROM livestock_groups g JOIN plots p ON p.id = g.plot_id
      WHERE g.user_id = $1 AND g.count > 0 AND g.deleted_at IS NULL ORDER BY p.name`, [h.userId]))
    .map(r => `${r.plot}:${r.n}`);
  const expenses = () => h.q(`SELECT amount::float AS amount FROM expenses WHERE user_id = $1 AND deleted_at IS NULL`, [h.userId]);
  const buy = async () => {
    h.fakeAgent.enqueueTool('add_livestock', { category: 'vaca', count: 3, plot: 'Norte', isPurchase: true });
    await h.send('compré 3 vacas en el Norte');
    expect(pendingActStore.get(h.phone)?.command).toBe('set_livestock_price');
  };

  beforeAll(async () => {
    h = await createPipelineHarness('precio-hacienda');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Tapera') RETURNING id`, [h.userId]);
    const fid = (f[0] as { id: number }).id;
    for (const name of ['Norte', '5g']) await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, $2)`, [fid, name]);
  });
  afterAll(async () => { await h?.cleanup(); });
  beforeEach(async () => {
    h.fakeAgent.reset();
    await h.send('cancelar');
    pendingActStore.clear(h.phone);
    await h.q(`DELETE FROM expenses WHERE user_id = $1`, [h.userId]);
    await h.q(`DELETE FROM livestock_movements WHERE user_id = $1`, [h.userId]);
    await h.q(`DELETE FROM livestock_groups WHERE user_id = $1`, [h.userId]);
  });

  it('H1: «tengo 7 vacas en el 5g» es un alta nueva, no el precio ni una corrección', async () => {
    await buy();
    h.fakeAgent.enqueueTool('add_livestock', { category: 'vaca', count: 7, plot: '5g' });
    const text = h.allText(await h.send('tengo 7 vacas en el 5g'));
    expect(await groups(), text).toEqual(['5g:7', 'Norte:3']);
    expect(await expenses()).toEqual([]);
  });

  it('H2: «fueron 1800» no cambia las cabezas', async () => {
    await buy();
    h.fakeAgent.enqueueTool('set_livestock_price', { unit_price: 1800, kind: 'expense' });
    const text = h.allText(await h.send('fueron 1800'));
    expect(await groups(), text).toEqual(['Norte:3']);
  });

  it('H2: con marca de corrección sí cambia las cabezas', async () => {
    await buy();
    const text = h.allText(await h.send('no, eran 5'));
    expect(await groups(), text).toEqual(['Norte:5']);
    expect(pendingActStore.get(h.phone)?.command).toBe('set_livestock_price');
  });

  it('otro botón de cancelar no cierra la pregunta de precio como «sin precio»', async () => {
    await buy();
    expect(h.allText(await h.tap('cancel_action'))).not.toMatch(/sin precio/);
  });

  it('H3: «Sin precio» cierra la pregunta y un número posterior no es un precio', async () => {
    await buy();
    await h.tap('lv_price_skip');
    expect(pendingActStore.get(h.phone)).toBeFalsy();
    await h.send('1800');
    expect(await expenses()).toEqual([]);
  });
});
