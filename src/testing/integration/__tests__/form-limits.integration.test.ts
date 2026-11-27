// Formularios contra el pipeline y la base reales: números en formato argentino
// y un rinde improbable que se pregunta en vez de perderse.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../pipeline-harness.js';
import { submitForm } from '../../../forms/form-submit.service.js';
import { formSessionService } from '../../../services/form-session.service.js';
import { getTodayISO } from '../../../utils/date.js';
import type { FormAction } from '../../../forms/form-definitions.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[form-limits.integration] DB no disponible — suite salteada');
}

describe.skipIf(!dbAvailable)('formularios: números y valores improbables', () => {
  let h: PipelineHarness;
  let plotId: number;

  const open = (action: FormAction) => formSessionService.create({
    userId: h.userId, action, prefill: {}, channel: 'testbot', channelId: 'x', phone: h.phone, hadPending: false,
  });

  beforeAll(async () => {
    h = await createPipelineHarness('formlimits');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Loma') RETURNING id`, [h.userId]);
    const fid = (f[0] as { id: number }).id;
    const p = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100) RETURNING id`, [fid]);
    plotId = (p[0] as { id: number }).id;
  });
  afterAll(async () => { await h?.cleanup(); });

  it('gasto de "1.500" guarda mil quinientos', async () => {
    const r = await submitForm(await open('log_expense'), {
      amount: '1.500', currency: 'ARS', category: 'Otros', category_other: 'Gasoil', location: `p:${plotId}`, event_date: getTodayISO(),
    }, { deliver: 'return' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const rows = await h.q(`SELECT amount::float AS amount FROM expenses WHERE user_id = $1`, [h.userId]);
    expect(rows).toEqual([{ amount: 1500 }]);
  });

  it('rinde improbable: no guarda, manda botones, y el botón guarda una sola vez', async () => {
    const sow = await submitForm(await open('sow_crop'), { plot_id: plotId, crop: 'soja', event_date: getTodayISO() }, { deliver: 'return' });
    expect(sow.ok, JSON.stringify(sow)).toBe(true);

    const token = await open('harvest_crop');
    const r = await submitForm(token, { plot_id: plotId, yield_kg_per_ha: '25.000', event_date: getTodayISO() }, { deliver: 'return' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const harvested = () => h.q(`SELECT yield_kg::float AS yield_kg FROM plot_crops WHERE plot_id = $1`, [plotId]);
    expect(await harvested()).toEqual([{ yield_kg: null }]);

    const buttons = r.ok && r.response?.interactive?.type === 'buttons' ? r.response.interactive.buttons : [];
    expect(buttons.map(b => b.title)).toEqual(['Sí, es correcto', 'Corregir']);
    expect(buttons[1].id).toBe('form_open_harvest');

    // El mismo formulario no se puede volver a enviar.
    const again = await submitForm(token, { plot_id: plotId, yield_kg_per_ha: '3000', event_date: getTodayISO() }, { deliver: 'return' });
    expect(again.ok).toBe(false);

    await h.tap(buttons[0].id);
    await h.tap(buttons[0].id);
    expect(await harvested()).toEqual([{ yield_kg: 2_500_000 }]);
    const events = await h.q(`SELECT id FROM domain_events WHERE user_id = $1 AND event_type = 'harvest'`, [h.userId]);
    expect(events).toHaveLength(1);
  });
});
