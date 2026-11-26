/**
 * Auditoría de datos (nov 2026), #6: repetir una siembra el mismo día confirmaba
 * "60 ha sembradas" sin guardarlas y duplicaba el evento. Contra la DB real y el
 * pipeline completo con FakeAgent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../../testing/integration/pipeline-harness.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('siembra repetida el mismo día', () => {
  let h: PipelineHarness;
  let fieldId: number;

  const newPlot = async (name: string) => {
    const p = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, $2, 100) RETURNING id`, [fieldId, name]);
    return (p[0] as { id: number }).id;
  };
  const campaigns = async (plotId: number) =>
    h.q(`SELECT * FROM plot_crops WHERE plot_id = $1 ORDER BY id`, [plotId]) as Promise<Array<Record<string, unknown>>>;
  const plantings = async (plotId: number) =>
    h.q(`SELECT * FROM domain_events WHERE plot_id = $1 AND event_type = 'planting' AND deleted_at IS NULL`, [plotId]);

  beforeAll(async () => {
    h = await createPipelineHarness('sow-repeat');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Siembra') RETURNING id`, [h.userId]);
    fieldId = (f[0] as { id: number }).id;
    await h.q(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [fieldId, h.userId]);
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
  });
  afterAll(async () => h?.cleanup());

  it('#6: "sembré soja" (lote entero) y luego "sembré 60 ha": actualiza las ha y NO duplica el evento', async () => {
    const plotId = await newPlot('Rep1');
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Rep1' });
    await h.send('sembré soja en Rep1');
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Rep1', hectares: 60 });
    const replies = await h.send('sembré 60 ha de soja en Rep1');
    const cs = await campaigns(plotId);
    expect(cs).toHaveLength(1);
    expect(Number(cs[0].sowed_hectares)).toBe(60);
    expect(await plantings(plotId)).toHaveLength(1);
    expect(JSON.stringify(replies)).toContain('actualizada');
  });

  it('#6: repetir exactamente "sembré 60 ha" no duplica el evento ni cambia nada', async () => {
    const plotId = await newPlot('Rep2');
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Rep2', hectares: 60 });
    await h.send('sembré 60 ha de soja en Rep2');
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Rep2', hectares: 60 });
    const replies = await h.send('sembré 60 ha de soja en Rep2');
    expect(await plantings(plotId)).toHaveLength(1);
    expect(Number((await campaigns(plotId))[0].sowed_hectares)).toBe(60);
    expect(JSON.stringify(replies)).toContain('ya estaba registrada');
  });

  it('#6: "otras 60 ha" sigue SUMANDO (comportamiento existente intacto)', async () => {
    const plotId = await newPlot('Rep3');
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Rep3', hectares: 40 });
    await h.send('sembré 40 ha de soja en Rep3');
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Rep3', hectares: 60 });
    await h.send('sembré otras 60 ha de soja en Rep3');
    expect(Number((await campaigns(plotId))[0].sowed_hectares)).toBe(100);
  });

  it('#14: una siembra con más ha que el lote se topea al lote y avisa', async () => {
    const plotId = await newPlot('Rep14'); // 100 ha
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Rep14', hectares: 150 });
    const replies = await h.send('sembré 150 ha de soja en Rep14');
    expect(Number((await campaigns(plotId))[0].sowed_hectares)).toBe(100);
    expect(JSON.stringify(replies)).toContain('lo dejé en el total del lote');
  });
});
