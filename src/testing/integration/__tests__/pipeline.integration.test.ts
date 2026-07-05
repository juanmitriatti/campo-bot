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
