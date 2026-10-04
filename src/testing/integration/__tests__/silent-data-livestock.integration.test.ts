/**
 * Datos silenciosos — hacienda (auditoría oct 2026, tanda 3). Pipeline completo
 * con FakeAgent contra la DB real.
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

describe.skipIf(!dbAvailable)('datos silenciosos — hacienda', () => {
  let h: PipelineHarness;
  let fid: number;
  const plotId = async (name: string) =>
    ((await h.q(`SELECT id FROM plots WHERE field_id = $1 AND name = $2`, [fid, name]))[0] as { id: number }).id;
  const groups = async (category: string) =>
    h.q(`SELECT g.count, g.breed, p.name AS plot FROM livestock_groups g LEFT JOIN plots p ON p.id = g.plot_id
          WHERE g.user_id = $1 AND g.category = $2 AND g.deleted_at IS NULL AND g.count > 0 ORDER BY g.id`, [h.userId, category]) as
      Promise<Array<{ count: number; breed: string | null; plot: string | null }>>;
  const seedGroup = async (plot: string, category: string, count: number, breed: string | null) =>
    h.q(`INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count) VALUES ($1, $2, $3, $4, $5, $6)`,
      [h.userId, fid, await plotId(plot), category, breed, count]);

  beforeAll(async () => {
    h = await createPipelineHarness('silent-data-lv');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Hacienda') RETURNING id`, [h.userId]);
    fid = (f[0] as { id: number }).id;
    await h.q(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [fid, h.userId]);
    await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100), ($1, 'Sur', 100), ($1, 'Bajo', 50)`, [fid]);
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
  });
  afterAll(async () => h?.cleanup());
  beforeEach(async () => {
    await h.send('cancelar');
    conversationLockStore.clear(h.phone);
    await h.q(`UPDATE livestock_groups SET deleted_at = NOW() WHERE user_id = $1 AND deleted_at IS NULL`, [h.userId]);
  });

  it('HAC-5 / HAC-7: "hay 45 vacas" con 50 Angus en el Sur ajusta ESE grupo (no crea uno sin raza ni va al lote del contexto)', async () => {
    await seedGroup('Sur', 'vaca', 50, 'Angus');
    h.fakeAgent.enqueueTool('log_spraying', { plot: 'Norte', product: 'glifosato' });
    await h.send('fumigué el Norte con glifosato'); // deja el Norte como contexto
    h.fakeAgent.enqueueTool('adjust_livestock', { category: 'vaca', count: 45 });
    await h.send('en realidad hay 45 vacas');
    expect(await groups('vaca')).toEqual([{ count: 45, breed: 'Angus', plot: 'Sur' }]);
  });

  it('HAC-6: "angus" en minúscula en una muerte encuentra el grupo "Angus"', async () => {
    await seedGroup('Sur', 'vaca', 30, 'Angus');
    h.fakeAgent.enqueueTool('record_livestock_death', { category: 'vaca', count: 2, breed: 'angus', plot: 'Sur' });
    const text = h.allText(await h.send('se murieron 2 vacas angus en el Sur'));
    expect(text).not.toMatch(/No hay/);
    expect(await groups('vaca')).toEqual([{ count: 28, breed: 'Angus', plot: 'Sur' }]);
  });

  it('HAC-31: "vendí 10 vacas del Norte" con vacas solo en el Sur no descuenta del Sur', async () => {
    await seedGroup('Sur', 'vaca', 40, null);
    h.fakeAgent.enqueueTool('remove_livestock', { category: 'vaca', count: 10, plot: 'Norte' });
    const text = h.allText(await h.send('vendí 10 vacas del Norte'));
    expect(text).toMatch(/No hay vacas en el lote Norte/i);
    expect(text).toMatch(/Sur \(40\)/);
    expect((await groups('vaca'))[0].count).toBe(40);
  });

  it('HAC-25: 2,5 cabezas y una muerte en el futuro se rechazan con un mensaje claro', async () => {
    await seedGroup('Sur', 'ternero', 20, null);
    h.fakeAgent.enqueueTool('record_livestock_death', { category: 'ternero', count: 2.5, plot: 'Sur' });
    expect(h.allText(await h.send('se murieron 2,5 terneros en el Sur'))).toMatch(/entero/);
    h.fakeAgent.enqueueTool('record_livestock_death', { category: 'ternero', count: 1, plot: 'Sur', event_date: '2031-01-10' });
    expect(h.allText(await h.send('se murió un ternero en el Sur el 10/01/2031'))).toMatch(/todavía no llegó|muy futura/);
    expect((await groups('ternero'))[0].count).toBe(20);
  });

  it('HAC-2: "a 2800 el kilo" como respuesta al precio pide el peso y calcula el total', async () => {
    await seedGroup('Sur', 'novillo', 30, null);
    h.fakeAgent.enqueueTool('remove_livestock', { category: 'novillo', count: 30, plot: 'Sur', is_sale: true });
    await h.send('vendí 30 novillos del Sur');
    const ask = h.allText(await h.send('a 2800 el kilo'));
    expect(ask).toMatch(/kilos pesaron/);
    await h.send('12000 kg');
    const inc = await h.q(`SELECT amount FROM incomes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [h.userId]);
    expect(Number((inc[0] as { amount: string }).amount)).toBe(2800 * 12000);
  });

  it('HAC-8: corregir la venta a más animales de los que había se rechaza', async () => {
    await seedGroup('Sur', 'toro', 50, null);
    h.fakeAgent.enqueueTool('remove_livestock', { category: 'toro', count: 40, plot: 'Sur', is_sale: true });
    await h.send('vendí 40 toros del Sur');
    const text = h.allText(await h.send('no, eran 80'));
    expect(text).toMatch(/No puedo dejar la venta en 80/);
    expect((await groups('toro'))[0].count).toBe(10);
  });

  it('HAC-15: un animal con caravana movido solo (sin su grupo) se puede dar de baja igual', async () => {
    await seedGroup('Sur', 'vaca', 10, null);
    h.fakeAgent.enqueueTool('register_animal', { category: 'vaca', rfid: '0000000077', plot: 'Sur' });
    await h.send('cargá la vaca 0000000077 en el Sur');
    h.fakeAgent.enqueueTool('move_animals', { animal_refs: ['0000000077'], dest_plot: 'Bajo' });
    await h.send('pasé la 0000000077 al Bajo');
    h.fakeAgent.enqueueTool('record_livestock_death', { category: 'vaca', count: 1, animal_ref: '0000000077' });
    const text = h.allText(await h.send('se murió la vaca 0000000077'));
    expect(text).not.toMatch(/No hay/);
    const a = await h.q(`SELECT status FROM animals WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [h.userId]);
    expect((a[0] as { status: string }).status).toBe('muerto');
  });

  it('HAC-23: un pesaje de 19.000 kg "promedio" se rechaza', async () => {
    await seedGroup('Sur', 'novillo', 50, null);
    h.fakeAgent.enqueueTool('log_weighing', { category: 'novillo', avg_weight_kg: 19000, plot: 'Sur' });
    expect(h.allText(await h.send('pesé los novillos del Sur, 19000 kg'))).toMatch(/no puede ser el peso promedio/);
  });
});
