/**
 * Tests de integración del pipeline COMPLETO con agente falso — cero API.
 * Cubren la clase de bugs que el eval (con API real) solo encuentra caro y
 * flaky: interacciones entre interceptores, mapper, validator, compound
 * executor y handlers contra la DB real.
 *
 * Requiere DB (Docker local :5433 o CI). Si no hay DB, se saltea entera.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../pipeline-harness.js';

let dbAvailable = true;
try {
  const { pool } = await import('../../../config/db.js');
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[pipeline.integration] DB no disponible — suite salteada');
}

describe.skipIf(!dbAvailable)('pipeline integration (FakeAgent, sin API)', () => {
  describe('compound multi-siembra con lotes con artículo (regresión "El Bajo", Jun 2026)', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('compound-siembra');
      // Setup por SQL: campo + 4 lotes (3 con artículo en el nombre REAL)
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'El Ombú') RETURNING id`, [h.userId]);
      const fid = (f[0] as { id: number }).id;
      for (const name of ['La Loma', 'El Bajo', 'La Cañada', 'El Monte']) {
        await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, $2)`, [fid, name]);
      }
    });
    afterAll(async () => h?.cleanup());

    it('3 sow_crop en compound persisten en SUS lotes — sin pendings ni pérdida', async () => {
      h.fakeAgent.enqueue([
        { toolName: 'sow_crop', toolInput: { crop: 'maíz', plot: 'El Bajo', field: 'El Ombú' } },
        { toolName: 'sow_crop', toolInput: { crop: 'trigo', plot: 'La Cañada', field: 'El Ombú' } },
        { toolName: 'sow_crop', toolInput: { crop: 'girasol', plot: 'El Monte', field: 'El Ombú' } },
      ]);
      const items = await h.send('sembré maíz en El Bajo, trigo en La Cañada y girasol en El Monte');
      const text = h.allText(items);

      expect(text).not.toContain('¿En qué lote');
      expect(text).not.toContain('acciones pendientes');

      const crops = await h.q(
        `SELECT pc.crop, p.name AS plot FROM plot_crops pc
         JOIN plots p ON p.id = pc.plot_id JOIN fields f ON f.id = p.field_id
         WHERE f.user_id = $1 ORDER BY pc.id`,
        [h.userId],
      );
      const byPlot = Object.fromEntries(crops.map(c => [c.plot, c.crop]));
      expect(byPlot['El Bajo']).toMatch(/ma[ií]z/i);
      expect(byPlot['La Cañada']).toMatch(/trigo/i);
      expect(byPlot['El Monte']).toMatch(/girasol/i);
    });
  });

  describe('pending de slot se consume SIN volver al agente', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('pending-slot');
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Santa Rosa') RETURNING id`, [h.userId]);
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Norte')`, [(f[0] as { id: number }).id]);
    });
    afterAll(async () => h?.cleanup());

    it('sow_crop sin cultivo → pregunta con pending; "soja" la consume el slot-extractor (0 llamadas extra al agente)', async () => {
      h.fakeAgent.enqueueTool('sow_crop', { plot: 'Norte', field: 'Santa Rosa' }); // agente omite crop
      const ask = await h.send('sembré en el lote Norte');
      expect(h.allText(ask)).toMatch(/qué cultivo/i);
      const callsAfterAsk = h.fakeAgent.calls.length;

      // La respuesta corta debe consumirla el pending-processor, NUNCA el agente
      const done = await h.send('soja');
      expect(h.fakeAgent.calls.length).toBe(callsAfterAsk); // agente NO llamado
      expect(h.allText(done)).toMatch(/soja/i);

      const crops = await h.q(
        `SELECT pc.crop FROM plot_crops pc JOIN plots p ON p.id = pc.plot_id
         JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1`,
        [h.userId],
      );
      expect(crops.length).toBe(1);
      expect(String(crops[0].crop)).toMatch(/soja/i);
    });
  });

  describe('hacienda ambigua lote-vs-feedlot → botones determinísticos (Jul 2026)', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('feedlot-btn');
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Esperanza') RETURNING id`, [h.userId]);
      const fid = (f[0] as { id: number }).id;
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'A1')`, [fid]);
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'A2')`, [fid]);
    });
    afterAll(async () => h?.cleanup());

    it('add_livestock ambiguo → botones Lote/Feedlot; tap feedlot → autocrea y ubica', async () => {
      h.fakeAgent.enqueueTool('add_livestock', {
        category: 'vaca', count: 50,
        // sin plot ni corral — como manda la regla de prompt
      });
      const ask = await h.send('tengo 50 vacas, no sé si van en un lote o en un feedlot');
      const buttons = h.allButtons(ask);
      const feedlotBtn = buttons.find(b => b.id.startsWith('lv_loc_feedlot_'));
      expect(feedlotBtn, `esperaba botón lv_loc_feedlot_*, hay: ${buttons.map(b => b.id).join(',')}`).toBeTruthy();
      expect(buttons.some(b => b.id.startsWith('lv_loc_lote_'))).toBe(true);

      const placed = await h.tap(feedlotBtn!.id);
      expect(h.allText(placed)).toMatch(/corral/i);

      const groups = await h.q(
        `SELECT category, count, corral_id, plot_id FROM livestock_groups WHERE user_id = $1 AND deleted_at IS NULL`,
        [h.userId],
      );
      expect(groups.length).toBe(1);
      expect(Number(groups[0].count)).toBe(50);
      expect(groups[0].corral_id).not.toBeNull();
      expect(groups[0].plot_id).toBeNull();
    });
  });

  describe('bugs rojos Jul 2026 — botones vencidos y stock fantasma', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('stale-buttons');
    });
    afterAll(async () => h?.cleanup());

    it('tap "Sí, descontar" con store vacío NO confirma descuento falso', async () => {
      const items = await h.tap('stock_deduct_yes_glifosato');
      const text = h.allText(items);
      expect(text).not.toContain('Stock descontado');
      expect(text).toMatch(/NO fue descontado/i);
    });

    it('tap de botón desconocido/vencido responde (nunca silencio)', async () => {
      const items = await h.tap('bap2_tokenvencido123_99');
      expect(items.length).toBeGreaterThan(0);
      expect(h.allText(items)).toMatch(/venció|expiró/i);
    });

    it('tap flow_* sin flow activo responde (nunca silencio)', async () => {
      const items = await h.tap('flow_plot_norte');
      expect(items.length).toBeGreaterThan(0);
      expect(h.allText(items)).toMatch(/venció|expiró/i);
    });

    it('confirm_destructive sin pending dice que NO borró nada', async () => {
      const items = await h.tap('confirm_destructive_x');
      expect(h.allText(items)).toMatch(/no borré nada/i);
    });
  });

  describe('Ronda 1 — auditoría profunda (Jul 2026)', () => {
    let h: PipelineHarness;
    let fieldId: number;
    let sojaPlotId: number;

    beforeAll(async () => {
      h = await createPipelineHarness('ronda1');
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Ronda') RETURNING id`, [h.userId]);
      fieldId = (f[0] as { id: number }).id;
      const p1 = await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'R1') RETURNING id`, [fieldId]);
      sojaPlotId = (p1[0] as { id: number }).id;
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'R2')`, [fieldId]);
    });
    afterAll(async () => h?.cleanup());

    it('R1.2: tap del category picker con token vencido → mensaje honesto (no crash mudo)', async () => {
      const cat = await h.q(
        `INSERT INTO user_categories (user_id, kind, name) VALUES ($1, 'expense', 'Combustible') RETURNING id`,
        [h.userId],
      );
      const items = await h.tap(`cat_pick_exp_TOKENVENCIDO123_${(cat[0] as { id: number }).id}`);
      const text = h.allText(items);
      expect(items.length).toBeGreaterThan(0); // nunca silencio
      expect(text).toMatch(/venció/i);
      expect(text).toMatch(/no se guardó nada/i);
    });

    it('R1.3: pivot durante "¿cuántos litros?" NO se come el mensaje ni descuenta', async () => {
      const { pendingStockDeductionStore } = await import('../../../services/message-pipeline.js');
      pendingStockDeductionStore.set(h.phone, { product: 'glifosato', unit: 'lt', awaitingQuantity: true });

      h.fakeAgent.enqueueTool('log_expense', { amount: 80000, category: 'Combustible', description: 'gasoil', plot: 'R1' });
      const items = await h.send('gasté 80 mil en gasoil en R1');
      const text = h.allText(items);
      expect(text).toMatch(/Dejé sin descontar/i);            // aviso del descuento diferido
      expect(h.fakeAgent.calls.length).toBeGreaterThan(0);     // el mensaje SÍ se procesó
      expect(text).not.toMatch(/Stock descontado/i);           // y NO descontó 80000 lt
      pendingStockDeductionStore.clear(h.phone);
    });

    it('R1.3b: "vendí 10 novillos" ya no cancela por el substring "no"', async () => {
      const { pendingStockDeductionStore } = await import('../../../services/message-pipeline.js');
      pendingStockDeductionStore.set(h.phone, { product: 'glifosato', unit: 'lt', awaitingQuantity: true });
      h.fakeAgent.enqueueTool('remove_livestock', { category: 'novillo', count: 10 });
      const items = await h.send('vendí 10 novillos');
      const text = h.allText(items);
      expect(text).not.toMatch(/OK, no se descontó/i); // antes: cancel accidental por "NOvillos"
      expect(text).toMatch(/Dejé sin descontar/i);     // ahora: pivot con aviso
      pendingStockDeductionStore.clear(h.phone);
    });

    it('R1.4: pivot durante "¿en qué localidad?" procesa el mensaje (antes se perdía)', async () => {
      const { pendingCityStore } = await import('../../../services/message-pipeline.js');
      pendingCityStore.set(h.phone, { fieldName: 'La Ronda' });
      h.fakeAgent.enqueueTool('log_expense', { amount: 200000, category: 'Semillas', description: 'semilla', plot: 'R1' });
      const items = await h.send('gasté 200 mil en semilla en R1');
      const text = h.allText(items);
      expect(text).toMatch(/Dejé pendiente la ubicación/i);   // el aviso sigue
      expect(h.fakeAgent.calls.some(c => c.text.includes('200'))).toBe(true); // y el gasto SE PROCESÓ
      pendingCityStore.clear(h.phone);
    });

    it('R1.5: "coseché 3000 kg" sin señal NO hereda el lote del contexto — pregunta', async () => {
      // contexto apuntando a R1 (como si la última consulta lo hubiera tocado)
      await h.q(
        `INSERT INTO conversation_state (user_id, last_field_id, last_plot_id, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_field_id = $2, last_plot_id = $3, updated_at = NOW()`,
        [h.userId, fieldId, sojaPlotId],
      );
      h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja', yield_kg: 3000 }); // sin plot
      const items = await h.send('coseché 3000 kg de soja');
      const text = h.allText(items);
      // Sin señal de contexto y con 2 lotes → debe PREGUNTAR, no escribir en R1
      expect(text).toMatch(/qué lote/i);
      const harvests = await h.q(`SELECT COUNT(*)::int AS n FROM domain_events WHERE user_id = $1 AND event_type = 'harvest'`, [h.userId]);
      expect((harvests[0] as { n: number }).n).toBe(0);
    });

    it('R1.5b: "cerrá la campaña" por contexto pide confirmación (no cierra a ciegas)', async () => {
      // aislar del test anterior: cancelar el pending de cosecha + cola limpia
      const { pendingActStore } = await import('../../../services/message-pipeline.js');
      pendingActStore.clear(h.phone);
      h.fakeAgent.reset();
      // campaña activa en R1 + contexto apuntando ahí (el ask de R1.5 limpió
      // last_plot_id — lo re-seteamos para simular "recién hablé de R1")
      await h.q(
        `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date) VALUES ($1, 'soja', 2025, 'gruesa', NOW())`,
        [sojaPlotId],
      );
      await h.q(
        `UPDATE conversation_state SET last_field_id = $2, last_plot_id = $3, updated_at = NOW() WHERE user_id = $1`,
        [h.userId, fieldId, sojaPlotId],
      );
      h.fakeAgent.enqueueTool('close_campaign', {}); // sin plot ni field
      const items = await h.send('cerrá la campaña');
      const buttons = h.allButtons(items);
      expect(h.allText(items)).toMatch(/¿Cierro la campaña de \*Soja\*/i);
      expect(buttons.some(b => b.id === 'campaign_close_yes_ctx')).toBe(true);
      // sigue activa hasta confirmar
      const active = await h.q(`SELECT COUNT(*)::int AS n FROM plot_crops WHERE plot_id = $1 AND end_date IS NULL`, [sojaPlotId]);
      expect((active[0] as { n: number }).n).toBe(1);
      // confirmar con el botón cierra
      const done = await h.tap('campaign_close_yes_ctx');
      expect(h.allText(done)).toMatch(/cerrada/i);
      const after = await h.q(`SELECT COUNT(*)::int AS n FROM plot_crops WHERE plot_id = $1 AND end_date IS NULL`, [sojaPlotId]);
      expect((after[0] as { n: number }).n).toBe(0);
    });

    it('R1.6: compound "sembré soja en R2 y maíz en R2" NO pisa — saltea con aviso', async () => {
      const { pendingActStore } = await import('../../../services/message-pipeline.js');
      pendingActStore.clear(h.phone);
      h.fakeAgent.reset();
      h.fakeAgent.enqueue([
        { toolName: 'sow_crop', toolInput: { crop: 'soja', plot: 'R2', hectares: 10 } },
        { toolName: 'sow_crop', toolInput: { crop: 'maíz', plot: 'R2', hectares: 130 } },
      ]);
      const items = await h.send('sembré 10 ha de soja en R2 y 130 ha de maíz en R2');
      const text = h.allText(items);
      expect(text).toMatch(/Siembra registrada/i);          // la soja entró
      expect(text).toMatch(/No sembré \*Maíz\*/i);           // el maíz se salteó con aviso
      expect(text).not.toMatch(/Cerré la campaña anterior/i); // NADA se pisó
      const r2 = await h.q(
        `SELECT pc.crop FROM plot_crops pc JOIN plots p ON p.id = pc.plot_id
         WHERE p.name = 'R2' AND p.field_id = $1 AND pc.end_date IS NULL`,
        [fieldId],
      );
      expect(r2.length).toBe(1);
      expect(String((r2[0] as { crop: string }).crop)).toMatch(/soja/i);
    });
  });

  describe('Ronda 2 — integridad de datos (Jul 2026)', () => {
    let h: PipelineHarness;
    let fieldId: number;

    beforeAll(async () => {
      h = await createPipelineHarness('ronda2');
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Dos Rondas') RETURNING id`, [h.userId]);
      fieldId = (f[0] as { id: number }).id;
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'D1')`, [fieldId]);
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'D2')`, [fieldId]);
    });
    afterAll(async () => h?.cleanup());

    it('R2.1: "no, era en lote D2" tras un GASTO corrige el gasto (no una actividad vieja)', async () => {
      const d1 = await h.q(`SELECT id FROM plots WHERE field_id = $1 AND name = 'D1'`, [fieldId]);
      const d1Id = (d1[0] as { id: number }).id;
      // actividad VIEJA en D1 (ayer) + gasto RECIÉN en D1
      await h.q(
        `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, created_at) VALUES ($1, $2, 'spraying', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')`,
        [h.userId, d1Id],
      );
      await h.q(
        `INSERT INTO expenses (user_id, field_id, plot_id, amount, currency, category, description) VALUES ($1, $2, $3, 80000, 'ARS', 'Combustible', 'gasoil')`,
        [h.userId, fieldId, d1Id],
      );

      const items = await h.send('no, era en lote D2');
      expect(h.fakeAgent.calls.length).toBe(0); // determinístico, sin agente

      const exp = await h.q(`SELECT p.name AS plot FROM expenses e JOIN plots p ON p.id = e.plot_id WHERE e.user_id = $1`, [h.userId]);
      expect(String((exp[0] as { plot: string }).plot)).toBe('D2');  // el GASTO se movió
      const act = await h.q(`SELECT p.name AS plot FROM domain_events d JOIN plots p ON p.id = d.plot_id WHERE d.user_id = $1`, [h.userId]);
      expect(String((act[0] as { plot: string }).plot)).toBe('D1');  // la actividad NO se tocó
      void items;
    });

    it('R2.2: delete del agente confirma con preview antes de borrar', async () => {
      h.fakeAgent.enqueueTool('delete_last_activity', {});
      const ask = await h.send('borrá la última actividad');
      const text = h.allText(ask);
      expect(text).toMatch(/Seguro que queres eliminar la ultima actividad/i);
      expect(text).toMatch(/Actividad: spraying/i); // preview del objetivo
      // NO borró todavía
      let acts = await h.q(`SELECT COUNT(*)::int AS n FROM domain_events WHERE user_id = $1`, [h.userId]);
      expect((acts[0] as { n: number }).n).toBe(1);
      // Confirmar borra
      const done = await h.tap('confirm_destructive_delete_last_activity');
      expect(h.allText(done)).toMatch(/eliminad|borrad|borré/i);
      acts = await h.q(`SELECT COUNT(*)::int AS n FROM domain_events WHERE user_id = $1 AND deleted_at IS NULL`, [h.userId]);
      expect((acts[0] as { n: number }).n).toBe(0); // soft-deleted
    });

    it('R2.4: plotNames numéricos del LLM no crashean — se coercionan a strings', async () => {
      h.fakeAgent.enqueueTool('add_plots_batch', { field: 'Dos Rondas', plotNames: [7, 8], hectares: [50, 60] });
      const items = await h.send('agregá los lotes 7 y 8');
      const text = h.allText(items);
      expect(text).toMatch(/Lotes creados|creado/i);
      const plots = await h.q(`SELECT name FROM plots WHERE field_id = $1 AND name IN ('7','8') ORDER BY name`, [fieldId]);
      expect(plots.length).toBe(2);
    });

    it('R2.5: el contexto NO hereda un lote borrado', async () => {
      const { plotDiscovery } = await import('../../../services/message-pipeline.js');
      const p = await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Borrado') RETURNING id`, [fieldId]);
      const pid = (p[0] as { id: number }).id;
      await h.q(
        `INSERT INTO conversation_state (user_id, last_field_id, last_plot_id, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_field_id = $2, last_plot_id = $3, updated_at = NOW()`,
        [h.userId, fieldId, pid],
      );
      await h.q(`UPDATE plots SET deleted_at = NOW() WHERE id = $1`, [pid]);
      const resolved = await plotDiscovery.resolveFromNames(h.userId, null, null);
      expect(resolved.plotId).not.toBe(pid); // jamás el borrado
    });
  });

  describe('guard anti-pisada de campaña (regresión "me cerró la campaña", Jul 2026)', () => {
    let h: PipelineHarness;
    let plotId: number;

    beforeAll(async () => {
      h = await createPipelineHarness('sow-guard');
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'los aromos') RETURNING id`, [h.userId]);
      const p = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, '3b', 140) RETURNING id`, [(f[0] as { id: number }).id]);
      plotId = (p[0] as { id: number }).id;
    });
    afterAll(async () => h?.cleanup());

    it('sembrar cultivo distinto en lote con campaña activa PREGUNTA (no cierra en silencio)', async () => {
      // 1. Siembra soja 10 ha en 3b
      h.fakeAgent.enqueueTool('sow_crop', { crop: 'soja', plot: '3b', hectares: 10 });
      await h.send('sembré 10 ha de soja en 3b');

      // 2. Maíz en el MISMO lote (heredado/explícito) → guard con botones
      h.fakeAgent.enqueueTool('sow_crop', { crop: 'maíz', plot: '3b', hectares: 130 });
      const ask = await h.send('y sembré 130 ha de maíz en 3b');
      const buttons = h.allButtons(ask);
      expect(h.allText(ask)).toMatch(/ya tiene \*Soja\* activa/i);
      const yesBtn = buttons.find(b => b.id.startsWith('sow_replace_') && b.id !== 'sow_replace_cancel');
      expect(yesBtn, 'botón Sí, reemplazar').toBeTruthy();
      expect(buttons.some(b => b.id === 'sow_replace_cancel')).toBe(true);

      // La soja SIGUE activa (nada se cerró todavía)
      let active = await h.q(`SELECT crop FROM plot_crops WHERE plot_id = $1 AND end_date IS NULL`, [plotId]);
      expect(active.length).toBe(1);
      expect(String(active[0].crop)).toMatch(/soja/i);

      // 3. Cancelar → sin cambios
      const cancel = await h.tap('sow_replace_cancel');
      expect(h.allText(cancel)).toMatch(/no toqué nada/i);
      active = await h.q(`SELECT crop FROM plot_crops WHERE plot_id = $1 AND end_date IS NULL`, [plotId]);
      expect(String(active[0].crop)).toMatch(/soja/i);

      // 4. Reintento y confirmo reemplazo → maíz activa + nota de cierre
      h.fakeAgent.enqueueTool('sow_crop', { crop: 'maíz', plot: '3b', hectares: 130 });
      const ask2 = await h.send('sembré 130 ha de maíz en 3b');
      const yes2 = h.allButtons(ask2).find(b => b.id.startsWith('sow_replace_') && b.id !== 'sow_replace_cancel')!;
      const done = await h.tap(yes2.id);
      expect(h.allText(done)).toMatch(/Siembra registrada/i);
      expect(h.allText(done)).toMatch(/Cerré la campaña anterior de soja/i);
      active = await h.q(`SELECT crop FROM plot_crops WHERE plot_id = $1 AND end_date IS NULL`, [plotId]);
      expect(active.length).toBe(1);
      expect(String(active[0].crop)).toMatch(/ma[ií]z/i);
    });
  });

  describe('set_field_city con ciudad ambigua muestra opciones (regresión "Junin", Jul 2026)', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('city-ambigua');
      await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'los aromos')`, [h.userId]);
    });
    afterAll(async () => h?.cleanup());

    it('"el campo está en Junin" → lista Junín Bs As / Mendoza (no re-pregunta genérica)', async () => {
      h.fakeAgent.enqueueTool('set_field_city', { field: 'los aromos', city: 'Junin' });
      const items = await h.send('El campo esta ubicado en Junin');
      const text = h.allText(items);
      expect(text).toMatch(/varias localidades/i);
      expect(text).toContain('Junín, Buenos Aires');
      expect(text).toContain('Junín, Mendoza');
      expect(text).not.toMatch(/¿En qué ciudad\/localidad/); // la re-pregunta ciega era el bug

      // La respuesta con provincia resuelve vía el pending (sin agente)
      const callsBefore = h.fakeAgent.calls.length;
      const done = await h.send('Junín, Buenos Aires');
      expect(h.fakeAgent.calls.length).toBe(callsBefore); // consumida por el pending handler
      expect(h.allText(done)).toMatch(/ubicado en .*Junín, Buenos Aires/i);
      const row = await h.q(`SELECT city, province FROM fields WHERE user_id = $1`, [h.userId]);
      expect(row[0].city).toBe('Junín');
      expect(row[0].province).toBe('Buenos Aires');
    });
  });

  describe('primera acción diferida — onboarding no descarta el gasto (Jul 2026)', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('deferred-first');
      // usuario CERO: sin campos ni lotes
    });
    afterAll(async () => h?.cleanup());

    it('gasto sin campos → stash; al crear campo+lote se re-inyecta solo', async () => {
      // 1. Primer mensaje: gasto → el agente lo mapea, el handler bloquea y stashea
      h.fakeAgent.enqueueTool('log_expense', { amount: 50000, category: 'Combustible', description: 'gasoil' });
      const blocked = await h.send('gasté 50 mil en gasoil');
      const blockedText = h.allText(blocked);
      expect(blockedText).toMatch(/necesitás crear un campo/i);
      expect(blockedText).toMatch(/retomo esto solo/i);

      // 2. Crear campo por SQL (simula el flujo de alta) — todavía sin lote
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Esperanza') RETURNING id`, [h.userId]);

      // 3. Crear el lote por el pipeline (comando trivial). El alta deja
      //    abierta la pregunta de hectáreas → el replay ESPERA su turno
      //    (fricción real Jul 2026: la pregunta de ha y el "Retomo" llegaban
      //    juntos y la respuesta del usuario era ambigua).
      h.fakeAgent.enqueueTool('add_plot', { plotName: 'Norte', field: 'La Esperanza' });
      const created = await h.send('agregar lote Norte al campo La Esperanza');
      const createdText = h.allText(created);
      expect(createdText).toMatch(/hectáreas/i); // la pregunta de ha llega SOLA
      expect(createdText).not.toMatch(/Retomo lo que me habías pedido/i);

      // 4. Respondida (salteada) la pregunta de ha → AHORA sí retoma el gasto.
      //    El replay re-corre el gasto: encolar la respuesta del agente para él.
      h.fakeAgent.enqueueTool('log_expense', { amount: 50000, category: 'Combustible', description: 'gasoil' });
      const done = await h.send('saltar');
      const doneText = h.allText(done);
      expect(doneText).toMatch(/Retomo lo que me habías pedido/i);
      expect(doneText).toMatch(/50/); // el monto reaparece

      // 5. El stash se consumió (no re-dispara en el próximo mensaje)
      const again = await h.send('hola');
      expect(h.allText(again)).not.toMatch(/Retomo lo que me habías pedido/i);
      void f;
    });
  });

  describe('trial vencido — readonly de verdad (Jul 2026)', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('trial-gate');
      await h.q(
        `INSERT INTO subscriptions (user_id, plan_id, status, billing_period, provider, trial_ends_at)
         VALUES ($1, 2, 'trial', 'monthly', 'trial', NOW() - INTERVAL '1 day')`,
        [h.userId],
      );
    });
    afterAll(async () => h?.cleanup());

    it('"hola" y "menú" siguen funcionando (costo cero) — el gate no bloquea triviales', async () => {
      const hola = await h.send('hola');
      expect(h.allText(hola)).not.toMatch(/prueba terminó/i);
      expect(h.fakeAgent.calls.length).toBe(0); // sin IA

      const menu = await h.send('menú');
      expect(h.allText(menu)).not.toMatch(/prueba terminó/i);
      expect(h.fakeAgent.calls.length).toBe(0);
    });

    it('un registro ("gasté...") sí bloquea, con el mensaje de plan y SIN llamar al agente', async () => {
      const items = await h.send('gasté 50 mil en gasoil');
      const text = h.allText(items);
      expect(text).toMatch(/prueba terminó/i);
      expect(text).toMatch(/dashboard/i);
      expect(h.fakeAgent.calls.length).toBe(0); // la IA nunca se llamó (no gastamos plata en vencidos)
    });

    it('R3.1: "plan" funciona con trial vencido — el CTA del gate no puede estar roto', async () => {
      const items = await h.send('plan');
      const text = h.allText(items);
      expect(text).toMatch(/tu plan/i);
      expect(text).toMatch(/dashboard/);
      expect(text).not.toMatch(/prueba terminó/i); // no lo bloquea el gate
      expect(h.fakeAgent.calls.length).toBe(0); // costo cero
    });
  });

  describe('activity_flow — consistencia de TODOS los tipos del picker (Jul 2026)', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('activity-flow-all');
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Rural') RETURNING id`, [h.userId]);
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Norte')`, [(f[0] as { id: number }).id]);
    });
    afterAll(async () => h?.cleanup());

    it('los 7 tipos agro completan el flow (picker→lote→[producto→cantidad]→confirmar) y guardan su evento', async () => {
      // tillage/harvest saltean producto/cantidad (skipIf del flow)
      const FLOW_TYPES = [
        { id: 'spraying', asksProduct: true },
        { id: 'fertilization', asksProduct: true },
        { id: 'planting', asksProduct: true },
        { id: 'tillage', asksProduct: false },
        { id: 'harvest', asksProduct: false },
        { id: 'irrigation', asksProduct: true },
        { id: 'tacto', asksProduct: true },
      ];
      for (const t of FLOW_TYPES) {
        const start = await h.tap('flow_new_activity');
        expect(h.allText(start)).toMatch(/qué actividad/i);
        const askPlot = await h.tap(`flow_activity_${t.id}`);
        expect(h.allText(askPlot)).toMatch(/lote/i);
        let next = await h.send('Norte');
        if (t.asksProduct) {
          expect(h.allText(next)).toMatch(/producto/i);
          next = await h.tap('flow_skip'); // producto
          next = await h.tap('flow_skip'); // cantidad
        }
        // Confirmación: UNA sola pregunta (sin el doble "¿Confirmamos?")
        const confText = h.allText(next);
        expect(confText).toMatch(/Registramos la actividad/i);
        expect(confText).not.toMatch(/¿Confirmamos\?/);
        const done = await h.tap('flow_confirm');
        expect(h.allText(done)).toMatch(/Actividad registrada/i);
        const ev = await h.q(
          `SELECT id FROM domain_events WHERE user_id = $1 AND event_type = $2`,
          [h.userId, t.id],
        );
        expect(ev.length).toBe(1); // exactamente un evento por tipo
      }
    });

    it('el picker NO ofrece eventos de hacienda; el tap del botón viejo redirige sin evento fantasma', async () => {
      const start = await h.tap('flow_new_activity');
      const raw = JSON.stringify(start);
      expect(raw).not.toMatch(/livestock_movement|Movimiento hacienda|health_event|weighing/);

      // Tap de un botón EN VUELO de una sesión vieja (el picker anterior sí
      // ofrecía "Movimiento hacienda") → redirect amigable, no el interrogatorio
      // de producto/cantidad que vio el usuario en prod.
      const redirect = await h.tap('flow_activity_livestock_movement');
      expect(h.allText(redirect)).toMatch(/contandomelo directo/i);
      expect(h.allText(redirect)).not.toMatch(/qué producto/i);

      await h.send('cancelar');
      const ghosts = await h.q(
        `SELECT 1 FROM domain_events WHERE user_id = $1 AND event_type = 'livestock_movement'`,
        [h.userId],
      );
      expect(ghosts.length).toBe(0); // sin evento fantasma
    });
  });

  describe('Ronda 3 — copy honesto de IA caída (Jul 2026)', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('ronda3-ai-down');
    });
    afterAll(async () => h?.cleanup());

    it('R3.3: el agente FALLA → el bot admite el problema técnico (no "no entendí" ni "tope diario")', async () => {
      h.fakeAgent.enqueueError('fake anthropic 529 overloaded');
      const items = await h.send('gasté 50 mil en gasoil');
      const text = h.allText(items);
      expect(text).toMatch(/problema técnico/i);
      expect(text).not.toMatch(/no entend/i); // no culpar al usuario
      expect(text).not.toMatch(/tope diario/i); // no mentir sobre el límite
    });
  });

  describe('escalera de escalamiento de pendings (anti-loop "Me falta el lote", Jul 2026)', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('pending-escal');
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'los aromos') RETURNING id`, [h.userId]);
      const fid = (f[0] as { id: number }).id;
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, '1A')`, [fid]);
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, '3b')`, [fid]);
      await h.q(`INSERT INTO plot_crops (plot_id, crop, season_year) SELECT p.id, 'soja', 2026 FROM plots p JOIN fields fl ON fl.id = p.field_id WHERE fl.user_id = $1 AND p.name = '3b'`, [h.userId]);
    });
    afterAll(async () => h?.cleanup());

    it('repro conversación real: "En otro lote" no envenena el pending — un "3b" posterior completa', async () => {
      // "quiero registrar una cosecha" → agente omite plot → "¿En qué lote?"
      h.fakeAgent.enqueueTool('harvest_crop', { crop: 'soja' });
      const ask = await h.send('quiero registrar una cosecha de soja');
      expect(h.allText(ask)).toMatch(/qué lote/i);
      const callsAfterAsk = h.fakeAgent.calls.length;

      // "En otro lote" se consume como nombre de lote ("otro lote") y no resuelve.
      // ANTES: el pending quedaba con data.plot="otro lote" → ni una respuesta
      // VÁLIDA posterior podía llenar el slot (loop infinito visto en prod).
      const junk = await h.send('En otro lote');
      // Nivel 1: el re-ask tiene que DECIR que no encontró ese lote y mostrar los reales
      expect(h.allText(junk)).toMatch(/no encontré/i);
      expect(h.allText(junk)).toMatch(/1A/);

      // La respuesta válida "3b" tiene que completar la cosecha (sin loop)
      const done = await h.send('3b');
      expect(h.fakeAgent.calls.length).toBe(callsAfterAsk); // todo determinístico
      expect(h.allText(done)).not.toMatch(/me falta el lote/i);
      const events = await h.q(
        `SELECT event_type FROM domain_events WHERE user_id = $1 AND event_type = 'harvest'`,
        [h.userId],
      );
      expect(events.length).toBe(1);
    });

    it('nivel 3: al 2do fallo el mensaje escala al AGENTE con el pending como contexto (nunca 3ra re-pregunta igual)', async () => {
      h.fakeAgent.enqueueTool('log_spraying', { product: 'glifosato', quantity: 10, unit: 'lt' }); // sin plot
      const ask = await h.send('fumigué con 10 litros de glifosato');
      expect(h.allText(ask)).toMatch(/qué lote/i);
      const callsAfterAsk = h.fakeAgent.calls.length;

      // Fallo 1: lote inexistente → razón + re-ask (determinístico, sin agente)
      const fail1 = await h.send('7c');
      expect(h.allText(fail1)).toMatch(/no encontré/i);
      expect(h.fakeAgent.calls.length).toBe(callsAfterAsk);

      // Fallo 2: NUNCA la misma pregunta por 3ra vez — escala al agente con
      // hint RESCATE + tag [contexto: ...] inline (validador acepta los tokens)
      h.fakeAgent.enqueue([], 'No tenés un lote 7c — ¿querés que lo cree en los aromos?');
      const fail2 = await h.send('7c');
      expect(h.fakeAgent.calls.length).toBe(callsAfterAsk + 1);
      const rescueCall = h.fakeAgent.calls[h.fakeAgent.calls.length - 1];
      expect(rescueCall.pendingHint).toMatch(/RESCATE DE PENDING/);
      expect(rescueCall.pendingHint).toMatch(/7c/); // el valor rechazado viaja
      expect(rescueCall.pendingHint).toMatch(/1A/); // el inventario real viaja
      expect(rescueCall.text).toMatch(/\[contexto: estaba completando log_spraying/);
      expect(h.allText(fail2)).toMatch(/7c/); // la respuesta del agente llegó al usuario
    });
  });

  describe('Ronda 3 — salida diferida de pendings (Jul 2026)', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('ronda3-deferral');
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Santa Rosa') RETURNING id`, [h.userId]);
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Norte')`, [(f[0] as { id: number }).id]);
    });
    afterAll(async () => h?.cleanup());

    it('R3.5: "después te digo" durante un pending → ack + el pending sigue vivo y la respuesta tardía completa', async () => {
      h.fakeAgent.enqueueTool('sow_crop', { plot: 'Norte', field: 'Santa Rosa' }); // agente omite crop
      const ask = await h.send('sembré en el lote Norte');
      expect(h.allText(ask)).toMatch(/qué cultivo/i);
      const callsAfterAsk = h.fakeAgent.calls.length;

      // Diferir NO cancela, NO se consume como cultivo, NO re-pregunta a secas
      const deferred = await h.send('después te digo');
      expect(h.fakeAgent.calls.length).toBe(callsAfterAsk); // sin agente
      expect(h.allText(deferred)).toMatch(/queda pendiente/i);
      expect(h.allText(deferred)).not.toMatch(/qué cultivo/i); // no insiste en el momento

      // La respuesta tardía completa el pending original
      const done = await h.send('soja');
      expect(h.fakeAgent.calls.length).toBe(callsAfterAsk);
      const crops = await h.q(
        `SELECT pc.crop FROM plot_crops pc JOIN plots p ON p.id = pc.plot_id
         JOIN fields f ON f.id = p.field_id WHERE f.user_id = $1`,
        [h.userId],
      );
      expect(crops.length).toBe(1);
      expect(String(crops[0].crop)).toMatch(/soja/i);
      expect(h.allText(done)).toMatch(/soja/i);
    });
  });

  describe('pronoun-expander ↔ validator (la interacción que causó el veto en vivo, May 2026)', () => {
    let h: PipelineHarness;

    beforeAll(async () => {
      h = await createPipelineHarness('pronoun');
      const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo Sur') RETURNING id`, [h.userId]);
      const fid = (f[0] as { id: number }).id;
      const p = await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Amarillo') RETURNING id`, [fid]);
      await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Verde')`, [fid]);
      // contexto reciente: el último write tocó Amarillo
      await h.q(
        `INSERT INTO conversation_state (user_id, last_field_id, last_plot_id, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_field_id = $2, last_plot_id = $3, updated_at = NOW()`,
        [h.userId, fid, (p[0] as { id: number }).id],
      );
    });
    afterAll(async () => h?.cleanup());

    it('"ahí mismo" llega al agente EXPANDIDO y el validator NO vetea el lote inyectado', async () => {
      h.fakeAgent.enqueueTool('log_expense', { amount: 50000, category: 'Combustible', plot: 'Amarillo' });
      const items = await h.send('gasté 50 mil en gasoil ahí mismo');

      // 1. El agente vio el texto expandido (no el pronombre crudo)
      expect(h.fakeAgent.calls.length).toBe(1);
      expect(h.fakeAgent.calls[0].text.toLowerCase()).toContain('amarillo');

      // 2. El validator NO vetó el lote inyectado por el expander: la única
      // manifestación del bug era la re-pregunta "¿en qué lote?". Que el flow
      // siga con otros pasos (categoría, confirmación) es comportamiento
      // normal — lo prohibido es perder el lote.
      const text = h.allText(items);
      expect(text).not.toMatch(/en qué lote/i);
      // Si el INSERT ya ocurrió (sin confirm-flow), el lote debe ser Amarillo.
      const exp = await h.q(
        `SELECT e.amount, p.name AS plot FROM expenses e LEFT JOIN plots p ON p.id = e.plot_id
         WHERE e.user_id = $1 AND e.deleted_at IS NULL`,
        [h.userId],
      );
      if (exp.length > 0) {
        expect(exp[0].plot).toBe('Amarillo');
      }
    });
  });
});
