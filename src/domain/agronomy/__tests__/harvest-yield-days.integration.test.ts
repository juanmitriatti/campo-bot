/**
 * Rinde de una cosecha de VARIOS días (migración 127), contra la DB real y el
 * pipeline completo con FakeAgent (sin API Anthropic). Auditoría oct 2026:
 *   AGR-2 / DSH-2  corregir o borrar un camión baja el rinde.
 *   AGR-3          borrar UN día de cosecha no borra el rinde ni las fechas de la campaña.
 *   AGR-4          el dashboard no suma los totales declarados en días distintos.
 *   AGR-9          "no, fueron 260 tn" corrige ese día, no la campaña entera.
 *   AGR-13         los camiones de "ayer" no se anexan a la cosecha de hoy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../../testing/integration/pipeline-harness.js';
import { deleteDomainEvent, deleteHarvestLoadById } from '../../../services/expenses.js';
import { harvestCampaignsCte } from '../../../utils/harvest-campaign-kg.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

const isoDaysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
};

describe.skipIf(!dbAvailable)('rinde de una cosecha de varios días', () => {
  let h: PipelineHarness;
  let fieldId: number;

  const newPlot = async (name: string, crop = 'soja') => {
    const p = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, $2, 100) RETURNING id`, [fieldId, name]);
    const plotId = (p[0] as { id: number }).id;
    const pc = await h.q(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date) VALUES ($1, $2, 2025, 'gruesa', '2025-11-10') RETURNING id`,
      [plotId, crop],
    );
    return { plotId, pcId: (pc[0] as { id: number }).id };
  };
  const campaign = async (pcId: number) =>
    (await h.q(`SELECT * FROM plot_crops WHERE id = $1`, [pcId]))[0] as Record<string, unknown>;
  const harvestEvents = async (pcId: number) =>
    h.q(`SELECT * FROM domain_events WHERE plot_crop_id = $1 AND event_type = 'harvest' AND deleted_at IS NULL ORDER BY id`, [pcId]);

  beforeAll(async () => {
    h = await createPipelineHarness('harvest-yield-days');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Cosecha') RETURNING id`, [h.userId]);
    fieldId = (f[0] as { id: number }).id;
    await h.q(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [fieldId, h.userId]);
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
  });
  afterAll(async () => h?.cleanup());

  it('AGR-2: borrar un camión baja el rinde (el piso es lo declarado, no el valor viejo)', async () => {
    const { pcId } = await newPlot('Camiones');
    h.fakeAgent.enqueueTool('harvest_crop', {
      crop: 'soja', plot: 'Camiones',
      loads: [{ driver_name: 'Pérez', weight_kg: 30000 }, { driver_name: 'Gómez', weight_kg: 25000 }],
    });
    await h.send('cosechamos soja en Camiones: Pérez 30000, Gómez 25000');
    expect(Number((await campaign(pcId)).yield_kg)).toBe(55000);

    const loads = await h.q(`SELECT id FROM harvest_loads WHERE plot_crop_id = $1 AND driver_name = 'Gómez'`, [pcId]);
    await deleteHarvestLoadById(Number(h.userId), (loads[0] as { id: number }).id);
    expect(Number((await campaign(pcId)).yield_kg)).toBe(30000);
  });

  it('AGR-3: borrar UN día de cosecha deja la campaña cosechada con el rinde y las fechas de los otros días', async () => {
    const { pcId } = await newPlot('DosDias');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'DosDias', hectares: 40, yield_kg_per_ha: 4200, event_date: isoDaysAgo(1) });
    await h.send('ayer cosechamos 40 ha de soja en DosDias, rindió 42 qq/ha');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'DosDias', hectares: 60, yield_kg_per_ha: 4000 });
    await h.send('hoy cosechamos 60 ha de soja en DosDias, rindió 40 qq/ha');
    let c = await campaign(pcId);
    expect(Number(c.yield_kg)).toBe(168000 + 240000);
    expect(Number(c.harvested_hectares)).toBe(100);

    const evs = await harvestEvents(pcId);
    expect(evs).toHaveLength(2);
    await deleteDomainEvent((evs[1] as { id: number }).id);

    c = await campaign(pcId);
    expect(c.harvested_at).not.toBeNull();
    expect(Number(c.yield_kg)).toBe(168000);
    expect(Number(c.harvested_hectares)).toBe(40);
  });

  it('AGR-3: borrar el único día no reabre una campaña cerrada si el lote ya se resembró', async () => {
    const { plotId, pcId } = await newPlot('Resembrado');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Resembrado', yield_kg: 300000 });
    await h.send('cosechamos la soja del Resembrado, sacamos 300 tn');
    await h.q(`UPDATE plot_crops SET end_date = CURRENT_DATE WHERE id = $1`, [pcId]);
    await h.q(`INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date) VALUES ($1, 'trigo', 2026, 'fina', CURRENT_DATE)`, [plotId]);

    const evs = await harvestEvents(pcId);
    await deleteDomainEvent((evs[0] as { id: number }).id);
    const c = await campaign(pcId);
    expect(c.end_date).not.toBeNull();
    expect(c.harvested_at).toBeNull();
  });

  it('AGR-4: dos días con rinde total declarado → el dashboard muestra el último, no la suma', async () => {
    const { pcId } = await newPlot('Totales');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Totales', yield_kg_per_ha: 4200, event_date: isoDaysAgo(1) });
    await h.send('ayer cosechamos la soja de Totales, rindió 42 qq/ha');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Totales', yield_kg_per_ha: 4500 });
    await h.send('terminamos la soja de Totales, rindió 45 qq/ha');
    expect(Number((await campaign(pcId)).yield_kg)).toBe(450000);

    const { rows } = await pool.query(
      `WITH ${harvestCampaignsCte({ user: '$1', from: '$2', to: '$3', fieldIds: '$4' })}
       SELECT kg FROM harvest_campaigns WHERE plot_crop_id = $5`,
      [h.userId, isoDaysAgo(30), isoDaysAgo(-1), [fieldId], pcId],
    );
    expect(Number(rows[0].kg)).toBe(450000);
  });

  it('AGR-9: "no, fueron 260 tn" corrige el segundo día, no el total de la campaña', async () => {
    const { pcId } = await newPlot('Correccion');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Correccion', hectares: 50, yield_kg: 200000, event_date: isoDaysAgo(1) });
    await h.send('ayer cosechamos 50 ha de soja en Correccion, sacamos 200 tn');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Correccion', hectares: 50, yield_kg: 250000 });
    await h.send('hoy cosechamos 50 ha de soja en Correccion, sacamos 250 tn');
    expect(Number((await campaign(pcId)).yield_kg)).toBe(450000);

    await h.send('no, fueron 260 tn');
    expect(Number((await campaign(pcId)).yield_kg)).toBe(460000);
  });

  it('AGR-13: camiones de "ayer" crean la cosecha de ayer, no se pegan a la de hoy', async () => {
    const { pcId } = await newPlot('Bajo');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Bajo', loads: [{ driver_name: 'Hoy', weight_kg: 30000 }] });
    await h.send('cosechamos soja en Bajo: Hoy 30000');
    h.fakeAgent.enqueueTool('harvest_crop', {
      crop: 'soja', plot: 'Bajo', event_date: isoDaysAgo(1), loads: [{ driver_name: 'Viejo', weight_kg: 28000 }],
    });
    await h.send('ayer salió un camión de soja del Bajo: Viejo 28000');

    const evs = await harvestEvents(pcId) as Array<{ id: number; event_date: Date }>;
    expect(evs).toHaveLength(2);
    const viejo = await h.q(
      `SELECT de.event_date::text AS d FROM harvest_loads hl JOIN domain_events de ON de.id = hl.domain_event_id
        WHERE hl.plot_crop_id = $1 AND hl.driver_name = 'Viejo'`,
      [pcId],
    );
    expect((viejo[0] as { d: string }).d).toBe(isoDaysAgo(1));
  });

  it('auditoría de datos #4: las hectáreas cosechadas se topean al lote ANTES de calcular el rinde', async () => {
    const { pcId } = await newPlot('Cien'); // lote de 100 ha
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Cien', hectares: 150, yield_kg_per_ha: 4000 });
    await h.send('cosechamos 150 ha de soja en Cien, rindió 40 qq/ha');
    const c = await campaign(pcId);
    expect(Number(c.harvested_hectares)).toBe(100);
    expect(Number(c.yield_kg)).toBe(400000); // 100 ha × 4.000 kg/ha, no 150 × 4.000 = 600.000
  });

  it('auditoría de datos #4: dos días que suman más que el lote: el segundo solo cuenta lo que faltaba', async () => {
    const { pcId } = await newPlot('Cien2Dias');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Cien2Dias', hectares: 60, yield_kg_per_ha: 4000, event_date: isoDaysAgo(1) });
    await h.send('ayer cosechamos 60 ha de soja en Cien2Dias, rindió 40 qq/ha');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Cien2Dias', hectares: 60, yield_kg_per_ha: 4000 });
    await h.send('hoy cosechamos 60 ha de soja en Cien2Dias, rindió 40 qq/ha');
    const c = await campaign(pcId);
    expect(Number(c.harvested_hectares)).toBe(100);
    expect(Number(c.yield_kg)).toBe(400000); // 240.000 + 40 ha × 4.000, no 480.000
  });

  it('auditoría de datos #5: un rinde fuera de techo (42 tn/ha de soja) no se guarda: pregunta con botones', async () => {
    const { pcId } = await newPlot('Techo5');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Techo5', yield_kg_per_ha: 42000 });
    const replies = await h.send('cosechamos soja en Techo5, rindió 42 tn/ha');
    const c = await campaign(pcId);
    expect(c.yield_kg).toBeNull();
    expect(c.harvested_at).toBeNull();
    const text = JSON.stringify(replies);
    expect(text).toContain('mucho más de lo habitual');
    expect(text).toContain('cmdtok_');
  });

  it('auditoría de datos #5: tocar "Sí, es correcto" guarda el rinde', async () => {
    const { pcId } = await newPlot('Techo5b');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Techo5b', yield_kg_per_ha: 42000 });
    const replies = await h.send('cosechamos soja en Techo5b, rindió 42 tn/ha');
    const id = JSON.stringify(replies).match(/cmdtok_[A-Za-z0-9_-]{8}/)?.[0];
    expect(id).toBeTruthy();
    await h.tap(id as string);
    expect(Number((await campaign(pcId)).yield_kg)).toBe(4_200_000);
  });

  it('auditoría de datos #5: un rinde normal (42 qq/ha) sigue guardándose sin preguntar', async () => {
    const { pcId } = await newPlot('Techo5c');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Techo5c', yield_kg_per_ha: 4200 });
    await h.send('cosechamos soja en Techo5c, rindió 42 qq/ha');
    expect(Number((await campaign(pcId)).yield_kg)).toBe(420000);
  });

  it('auditoría de datos #16: un rinde negativo no se guarda (había una cosecha de -500 kg en la base)', async () => {
    const { pcId } = await newPlot('Neg16');
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Neg16', yield_kg: -500 });
    const replies = await h.send('cosechamos soja en Neg16, rindió -500 kg');
    const c = await campaign(pcId);
    expect(c.yield_kg).toBeNull();
    expect(c.harvested_at).toBeNull();
    expect(JSON.stringify(replies)).toContain('mayor a 0');
  });

  it('auditoría de datos #17: un evento viejo con unidad "qq/ha" no se suma como kilos', async () => {
    const { plotId } = await newPlot('Unid17');
    const add = (qty: number, unit: string) => h.q(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, crop, quantity, unit) VALUES ($1, $2, 'harvest', $3, 'soja', $4, $5)`,
      [h.userId, plotId, isoDaysAgo(2), qty, unit],
    );
    await add(10, 'tn');
    await add(42, 'qq/ha');
    const rows = await h.q(
      `WITH ${harvestCampaignsCte({ user: '$1', from: '$2', to: '$3', fieldIds: '$4' })}
       SELECT COALESCE(SUM(kg), 0) AS kg FROM harvest_campaigns WHERE plot_id = $5`,
      [h.userId, isoDaysAgo(30), isoDaysAgo(-1), [fieldId], plotId],
    );
    expect(Number((rows[0] as { kg: string }).kg)).toBe(10000); // antes 10.042
  });

  it('auditoría de datos #20: una fecha "05/11" del agente se guarda como 5 de noviembre, no 11 de mayo', async () => {
    const { plotId } = await newPlot('Fecha20');
    h.fakeAgent.enqueueTool('log_expense', { amount: 1000, category: 'Combustible', plot: 'Fecha20', event_date: '05/11/2025' });
    await h.send('gasté 1000 en gasoil en Fecha20 el 5 de noviembre del año pasado');
    const rows = await h.q(`SELECT to_char(expense_date, 'YYYY-MM-DD') AS d FROM expenses WHERE plot_id = $1`, [plotId]);
    expect((rows[0] as { d: string } | undefined)?.d).toBe('2025-11-05');
  });
});
