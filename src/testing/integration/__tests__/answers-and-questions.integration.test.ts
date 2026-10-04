/**
 * Respuestas y preguntas (auditoría oct 2026, tanda 4). Cuando el bot espera un
 * dato, una acción nueva o una consulta NO es la respuesta (causa 3), y toda
 * pregunta deja su pending con escalera (causa 8). Pipeline completo con
 * FakeAgent contra la DB real.
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

describe.skipIf(!dbAvailable)('respuestas y preguntas', () => {
  let h: PipelineHarness;
  let fid: number;
  const count = async (sql: string) => Number(((await h.q(sql, [h.userId]))[0] as { n: number }).n);
  const plantings = () => count(`SELECT COUNT(*)::int AS n FROM domain_events WHERE user_id = $1 AND event_type = 'planting' AND deleted_at IS NULL`);

  beforeAll(async () => {
    h = await createPipelineHarness('answers-questions');
    const f = await h.q(`INSERT INTO fields (user_id, name, city) VALUES ($1, 'La Loma', 'Pergamino') RETURNING id`, [h.userId]);
    fid = (f[0] as { id: number }).id;
    await h.q(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [fid, h.userId]);
    await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100), ($1, 'Sur', 80)`, [fid]);
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    const { CategoryRepository } = await import('../../../domain/financial/category.repository.js');
    const { CategoryService } = await import('../../../domain/financial/category.service.js');
    const cs = new CategoryService(new CategoryRepository());
    await cs.bootstrapDefaults(Number(h.userId), 'expense');
    await cs.bootstrapDefaults(Number(h.userId), 'income');
  });
  afterAll(async () => h?.cleanup());
  beforeEach(async () => {
    await h.send('cancelar');
    conversationLockStore.clear(h.phone);
    await h.q(`DELETE FROM plot_crops WHERE plot_id IN (SELECT id FROM plots WHERE field_id = $1)`, [fid]);
    await h.q(`UPDATE domain_events SET deleted_at = NOW() WHERE user_id = $1 AND deleted_at IS NULL`, [h.userId]);
    await h.q(`UPDATE livestock_groups SET deleted_at = NOW() WHERE user_id = $1 AND deleted_at IS NULL`, [h.userId]);
    h.fakeAgent.reset();
  });

  it('CONV-1: después de "+ Otra", una acción nueva no se toma como nombre de categoría', async () => {
    h.fakeAgent.enqueueTool('log_expense', { amount: 70000, description: 'cosas varias', plot: 'Norte', field: 'La Loma' });
    const pick = await h.send('gasté 70 mil en cosas varias en el Norte');
    const otra = h.allButtons(pick).find(b => b.id.startsWith('cat_new_exp_'));
    expect(otra, 'esperaba el botón + Otra').toBeTruthy();
    await h.tap(otra!.id);
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Sur', field: 'La Loma' });
    await h.send('sembré soja en el lote Sur');
    expect(await plantings()).toBe(1);
    expect(await count(`SELECT COUNT(*)::int AS n FROM user_categories WHERE user_id = $1 AND name ILIKE '%sembr%'`)).toBe(0);
  });

  it('CONV-5: en el paso "¿En qué lote?" de un gasto, "sembré soja en el lote Sur" es una siembra, no el lote', async () => {
    h.fakeAgent.enqueueTool('log_expense', { amount: 50000, category: 'Combustible', description: 'gasoil', field: 'La Loma' });
    await h.send('gasté 50 mil en gasoil');
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: 'Sur', field: 'La Loma' });
    await h.send('sembré soja en el lote Sur');
    expect(await plantings()).toBe(1);
  });

  it('CONV-11: "dale" no es un producto y "12345" no es un cultivo', async () => {
    h.fakeAgent.enqueueTool('sow_crop', { plot: 'Norte', field: 'La Loma' });
    expect(h.allText(await h.send('sembré en el Norte'))).toMatch(/qué cultivo/i);
    const txt = h.allText(await h.send('12345'));
    expect(txt).toMatch(/cultivo/i);
    expect(await plantings()).toBe(0);
  });

  it('CONV-18: "hola" con una pregunta abierta no gasta intentos ni la borra', async () => {
    h.fakeAgent.enqueueTool('sow_crop', { plot: 'Norte', field: 'La Loma' });
    await h.send('sembré en el Norte');
    await h.send('hola');
    await h.send('gracias');
    await h.send('soja');
    expect(await plantings()).toBe(1);
  });

  it('HAC-1: con el precio de una compra pendiente, "se me murió una vaca" registra la muerte, no un gasto de $1', async () => {
    await h.q(`INSERT INTO livestock_groups (user_id, field_id, plot_id, category, count)
               SELECT $1, $2, id, 'vaca', 30 FROM plots WHERE field_id = $2 AND name = 'Sur'`, [h.userId, fid]);
    h.fakeAgent.enqueueTool('add_livestock', { category: 'toro', count: 5, plot: 'Sur', is_purchase: true });
    expect(h.allText(await h.send('compré 5 toros para el Sur'))).toMatch(/A cuánto fue la compra/);
    h.fakeAgent.enqueueTool('record_livestock_death', { category: 'vaca', count: 1, plot: 'Sur' });
    await h.send('se me murió una vaca');
    expect(await count(`SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1 AND amount < 10 AND deleted_at IS NULL`)).toBe(0);
    const v = await h.q(`SELECT count FROM livestock_groups WHERE user_id = $1 AND category = 'vaca' AND deleted_at IS NULL`, [h.userId]);
    expect(Number((v[0] as { count: number }).count)).toBe(29);
  });

  it('HAC-12: "20 de 380 kilos" a "¿Cuántas cabezas?" son 20, no 380', async () => {
    h.fakeAgent.enqueueTool('add_livestock', { category: 'novillo', plot: 'Norte' });
    expect(h.allText(await h.send('compré novillos para el Norte'))).toMatch(/Cuántas cabezas/i);
    await h.send('20 de 380 kilos');
    const g = await h.q(`SELECT count FROM livestock_groups WHERE user_id = $1 AND category = 'novillo' AND deleted_at IS NULL`, [h.userId]);
    expect(Number((g[0] as { count: number }).count)).toBe(20);
  });

  it('CAM-15: "unirme ABC123" no depende del agente', async () => {
    const before = h.fakeAgent.calls.length;
    await h.send('unirme ABC123');
    expect(h.fakeAgent.calls.length).toBe(before);
  });

  it('CAM-17 / CAM-9 / CAM-16: alta de campo "sin localidad", sin renombrarlo, y "sí" lo confirma', async () => {
    h.fakeAgent.enqueueTool('add_field', { field: 'El Paraje' });
    await h.send('agregá el campo El Paraje');
    // Paso "¿Cómo lo ubicamos?" (si está) → localidad.
    await h.send('escribir localidad');
    const t1 = h.allText(await h.send('no figura, es un paraje'));
    expect(t1).not.toMatch(/un paraje\*/);
    await h.send('sí');
    const f = await h.q(`SELECT name, city FROM fields WHERE user_id = $1 AND name ILIKE '%paraje%' AND deleted_at IS NULL`, [h.userId]);
    expect(f).toHaveLength(1);
    expect((f[0] as { name: string }).name).toBe('El Paraje');
  });

  it('AGR-11: camiones sin lote con una cosecha hoy → [Sí, sumarlas] guarda las cargas', async () => {
    await h.q(`INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date) SELECT id, 'soja', 2025, 'gruesa', '2025-11-10' FROM plots WHERE field_id = $1 AND name = 'Norte'`, [fid]);
    h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', plot: 'Norte', field: 'La Loma' });
    await h.send('cosechamos la soja del Norte');
    await h.q(`DELETE FROM conversation_state WHERE user_id = $1`, [h.userId]);
    h.fakeAgent.enqueueTool('harvest_crop', { loads: [{ driver_name: 'Pedro', weight_kg: 30000 }] });
    const ask = await h.send('Pedro 30000');
    const yes = h.allButtons(ask).find(b => b.title.startsWith('Sí'));
    expect(yes, `esperaba [Sí, sumarlas], hubo: ${h.allText(ask)}`).toBeTruthy();
    await h.tap(yes!.id);
    expect(await count(`SELECT COUNT(*)::int AS n FROM harvest_loads hl JOIN domain_events de ON de.id = hl.domain_event_id WHERE de.user_id = $1 AND hl.driver_name = 'Pedro'`)).toBe(1);
  });

  it('CONV-6: en "¿Algún detalle?" de un gasto completo, una acción nueva guarda el gasto y procesa la acción', async () => {
    h.fakeAgent.enqueueTool('log_expense', { amount: 33000, category: 'Combustible', description: 'gasoil', field: 'La Loma' });
    await h.send('gasté 33 mil en gasoil');
    await h.tap('flow_plot_norte');
    h.fakeAgent.enqueueTool('sow_crop', { crop: 'maíz', plot: 'Sur', field: 'La Loma' });
    await h.send('sembré maíz en el Sur');
    expect(await plantings()).toBe(1);
    expect(await count(`SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1 AND amount = 33000 AND deleted_at IS NULL`)).toBe(1);
  });

  it('FIN-32 / FIN-36: "ok" re-muestra la tarjeta y un comentario se suma como detalle', async () => {
    await h.q(`UPDATE user_settings SET confirm_before_save = true WHERE user_id = $1`, [h.userId]);
    try {
      h.fakeAgent.enqueueTool('log_expense', { amount: 44000, category: 'Combustible', description: 'gasoil', plot: 'Norte', field: 'La Loma' });
      await h.send('gasté 44 mil de gasoil en el Norte');
      expect(h.allText(await h.send('ok'))).toMatch(/Confirmo gasto/);
      expect(h.allText(await h.send('era para la sembradora'))).toMatch(/detalle/);
      await h.tap('confirm_pending');
      const e = await h.q(`SELECT description FROM expenses WHERE user_id = $1 AND amount = 44000 AND deleted_at IS NULL`, [h.userId]);
      expect(String((e[0] as { description: string }).description)).toMatch(/sembradora/);
    } finally {
      await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
    }
  });

  it('FIN-38: "Saltar" de un teclado viejo no dice "Hubo un problema con el flujo"', async () => {
    expect(h.allText(await h.tap('flow_skip'))).not.toMatch(/Hubo un problema/);
  });

  it('CONV-7: venta sin precio + "300 dólares por tn" abre la pregunta de lote como flow y guarda', async () => {
    h.fakeAgent.enqueueTool('log_income', { category: 'Soja', quantity: 10, unit: 'tn', field: 'La Loma', plot: 'Oeste' });
    await h.send('vendí 10 tn de soja del lote Oeste');
    const t = await h.send('300 dólares por tn');
    const norte = h.allButtons(t).find(b => b.id === 'flow_plot_norte');
    if (norte) {
      await h.tap(norte.id);
      await h.tap('flow_confirm');
    }
    expect(await count(`SELECT COUNT(*)::int AS n FROM incomes WHERE user_id = $1 AND amount = 3000 AND currency = 'USD' AND deleted_at IS NULL`)).toBe(1);
  });

  it('CONV-12: compuesto "creá el lote Este y gasté 20 mil en gasoil" — el gasto no hereda el lote nuevo', async () => {
    h.fakeAgent.enqueue([
      { toolName: 'add_plot', toolInput: { plot: 'Este', field: 'La Loma', hectares: 30 } },
      { toolName: 'log_expense', toolInput: { amount: 20000, category: 'Combustible', description: 'gasoil', field: 'La Loma' } },
    ]);
    await h.send('creá el lote Este de 30 ha y gasté 20 mil en gasoil');
    const e = await h.q(`SELECT p.name FROM expenses e LEFT JOIN plots p ON p.id = e.plot_id WHERE e.user_id = $1 AND e.amount = 20000 AND e.deleted_at IS NULL`, [h.userId]);
    expect((e[0] as { name: string | null }).name).toBeNull();
  });

  it('AGR-12: un recordatorio sin fecha pregunta con pending y la respuesta lo crea', async () => {
    h.fakeAgent.enqueueTool('create_reminder', { description: 'pagar el flete' });
    await h.send('acordame de pagar el flete');
    await h.send('el viernes a las 18');
    expect(await count(`SELECT COUNT(*)::int AS n FROM task_reminders WHERE user_id = $1`)).toBe(1);
  });
});
