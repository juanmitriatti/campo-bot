// Borrar siembras: con monitoreos encima, y una tanda sin borrar la campaña.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../pipeline-harness.js';
import { deleteDomainEvent } from '../../../services/expenses.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[sow-delete] DB no disponible — suite salteada');
}

describe.skipIf(!dbAvailable)('borrar siembras', () => {
  let h: PipelineHarness;
  let plotId: number;
  const campaign = async () => (await h.q(
    `SELECT sowed_hectares::float AS ha, start_date::text AS start FROM plot_crops WHERE plot_id = $1`, [plotId]));
  const plantings = async () => (await h.q(
    `SELECT id FROM domain_events WHERE plot_id = $1 AND event_type = 'planting' AND deleted_at IS NULL ORDER BY id`, [plotId]))
    .map(r => (r as { id: number }).id);

  beforeAll(async () => {
    h = await createPipelineHarness('siembra-borrado');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Los Ñandúes') RETURNING id`, [h.userId]);
    const p = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Grande', 100) RETURNING id`, [(f[0] as { id: number }).id]);
    plotId = (p[0] as { id: number }).id;
  });
  afterAll(async () => { await h?.cleanup(); });

  it('borrar la segunda tanda (topeada al lote) deja la primera; con monitoreo se puede borrar todo', async () => {
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Grande', hectares: 80 });
    await h.send('sembré 80 ha de soja en el Grande');
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Grande', hectares: 40 });
    await h.send('sembré otras 40 ha de soja en el Grande');
    expect((await campaign())[0]).toMatchObject({ ha: 100 });

    const [first, second] = await plantings();
    await deleteDomainEvent(second);
    expect((await campaign())[0]).toMatchObject({ ha: 80 });
    expect(await plantings()).toEqual([first]);

    const pc = await h.q(`SELECT id FROM plot_crops WHERE plot_id = $1`, [plotId]);
    await h.q(`INSERT INTO crop_scoutings (user_id, plot_id, plot_crop_id, scouting_date) VALUES ($1, $2, $3, CURRENT_DATE)`,
      [h.userId, plotId, (pc[0] as { id: number }).id]);
    await deleteDomainEvent(first);
    expect(await campaign()).toEqual([]);
    const scouting = await h.q(`SELECT plot_crop_id FROM crop_scoutings WHERE plot_id = $1`, [plotId]);
    expect(scouting).toEqual([{ plot_crop_id: null }]);
  });
});
