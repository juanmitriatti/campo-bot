/**
 * Stock y documentos — segunda ronda de la auditoría (oct 2026), contra la DB
 * real y el pipeline con FakeAgent (sin API Anthropic).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../../testing/integration/pipeline-harness.js';
import { StockService } from '../stock.service.js';
import { pendingDocumentStore } from '../../../services/message-pipeline.js';
import type { ChannelContext } from '../../../services/message-pipeline.js';
import { makeDocCallbackHandler } from '../../../services/document-pipeline.js';
import { buildSuggestedExpenses } from '../../documents/document.helpers.js';
import type { DocumentExtraction } from '../../../types/index.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('stock y documentos (auditoría oct 2026, segunda ronda)', () => {
  let h: PipelineHarness;
  let alfaId: number;
  let betaId: number;
  let whAlfa: number;
  let whBeta: number;
  const svc = new StockService();
  const item = async (name: string) =>
    h.q(`SELECT si.*, w.field_id FROM stock_items si JOIN warehouses w ON w.id = si.warehouse_id
          WHERE si.user_id = $1 AND LOWER(si.name) = LOWER($2) AND si.deleted_at IS NULL ORDER BY si.id`, [h.userId, name]);

  beforeAll(async () => {
    h = await createPipelineHarness('stock-audit');
    const a = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Alfa') RETURNING id`, [h.userId]);
    const b = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Beta') RETURNING id`, [h.userId]);
    alfaId = (a[0] as { id: number }).id;
    betaId = (b[0] as { id: number }).id;
    for (const f of [alfaId, betaId]) {
      await h.q(`INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`, [f, h.userId]);
    }
    await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 100), ($2, 'Sur', NULL)`, [alfaId, betaId]);
    whAlfa = (await h.q(`INSERT INTO warehouses (field_id, name) VALUES ($1, 'Galpón Alfa') RETURNING id`, [alfaId]))[0].id as number;
    whBeta = (await h.q(`INSERT INTO warehouses (field_id, name) VALUES ($1, 'Galpón Beta') RETURNING id`, [betaId]))[0].id as number;
    await h.q(`UPDATE user_settings SET confirm_before_save = false WHERE user_id = $1`, [h.userId]);
  });
  afterAll(async () => h?.cleanup());

  it('STK-1: cargar sin decir dónde suma al ítem existente en el otro galpón, no crea un duplicado', async () => {
    await svc.addStockToWarehouse(h.userId, whBeta, 'Atrazina', 'agroquimicos', 100, 'lt');
    await svc.addStock(h.userId, 'atrazina', 120, 'litros');
    const rows = await item('atrazina');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].current_quantity)).toBe(220);
  });

  it('STK-13 / STK-10: "litros" sobre lt y "tn" sobre kg se convierten en vez de fallar', async () => {
    await svc.addStockToWarehouse(h.userId, whAlfa, 'Maíz', 'granos', 5000, 'kg');
    const { item: after } = await svc.removeStock(h.userId, 'maíz', 2, 'tn', { category: 'granos' });
    expect(Number(after.current_quantity)).toBe(3000);
  });

  it('STK-3: un rinde por hectárea nunca se carga como cantidad de stock', async () => {
    await expect(svc.addGrainStock(h.userId, 'Soja', 42, 'qq/ha', { fieldId: alfaId })).rejects.toThrow(/por hectárea/);
    expect(await item('soja')).toHaveLength(0);
  });

  it('STK-2: "Sí, cargar" de una compra del campo Beta entra al galpón de Beta', async () => {
    h.fakeAgent.enqueueTool('log_expense', {
      amount: 300000, category: 'Agroquímicos', description: 'Glifosato', product: 'Glifosato',
      quantity: 50, unit: 'lt', field: 'Beta', expense_type: 'insumo',
    });
    const offer = await h.send('compré 50 lt de glifosato para el campo Beta, 300 mil');
    const yes = h.allButtons(offer).find(b => b.id.startsWith('stock_entry_yes_'));
    expect(yes, 'esperaba el botón Sí, cargar').toBeTruthy();
    expect(h.allText(offer)).not.toMatch(/undefined/);
    await h.tap(yes!.id);
    const rows = await item('glifosato');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].field_id)).toBe(betaId);
  });

  it('STK-9: dosis por ha en un lote sin superficie pregunta el total, no descuenta 2 lt', async () => {
    await svc.addStockToWarehouse(h.userId, whBeta, '2,4-D', 'agroquimicos', 40, 'lt');
    h.fakeAgent.enqueueTool('log_spraying', { plot: 'Sur', field: 'Beta', product: '2,4-D', quantity: 2, unit: 'lt/ha' });
    const text = h.allText(await h.send('fumigué el Sur de Beta con 2,4-D a 2 lt/ha'));
    expect(text).toMatch(/¿Descontar del stock\?/);
    expect(text).not.toMatch(/Descontar \*2 lt\*/);
  });

  it('STK-11: con el producto en dos galpones, descuenta del galpón del campo de la actividad', async () => {
    await svc.addStockToWarehouse(h.userId, whAlfa, 'Urea', 'fertilizantes', 1000, 'kg');
    await svc.addStockToWarehouse(h.userId, whBeta, 'Urea', 'fertilizantes', 500, 'kg');
    h.fakeAgent.enqueueTool('log_fertilization', { plot: 'Norte', field: 'Alfa', product: 'Urea', quantity: 200, unit: 'kg' });
    const offer = await h.send('fertilicé el Norte de Alfa con 200 kg de urea');
    const yes = h.allButtons(offer).find(b => b.id.startsWith('stock_deduct_yes_'));
    expect(yes).toBeTruthy();
    await h.tap(yes!.id);
    const rows = await item('urea') as Array<{ field_id: number; current_quantity: string }>;
    expect(Number(rows.find(r => Number(r.field_id) === alfaId)!.current_quantity)).toBe(800);
    expect(Number(rows.find(r => Number(r.field_id) === betaId)!.current_quantity)).toBe(500);
  });

  it('STK-8: la venta de soja no propone descontar "Semilla soja"', async () => {
    await svc.addStockToWarehouse(h.userId, whAlfa, 'Semilla soja', 'semillas', 30, 'bolsa');
    h.fakeAgent.enqueueTool('log_income', { amount: 9000000, category: 'Soja', quantity: 30, unit: 'tn', field: 'Alfa' });
    const text = h.allText(await h.send('vendí 30 tn de soja del campo Alfa por 9 palos'));
    expect(text).not.toMatch(/Semilla soja/);
  });

  it('STK-15: sin la feature de stock no se ofrece cargar ni el tap escribe', async () => {
    const free = await h.q(`SELECT id FROM plans WHERE name = 'free'`);
    const original = await h.q(`SELECT plan_id FROM users WHERE id = $1`, [h.userId]);
    await h.q(`UPDATE users SET plan_id = $2 WHERE id = $1`, [h.userId, (free[0] as { id: number }).id]);
    try {
      h.fakeAgent.enqueueTool('log_expense', {
        amount: 50000, category: 'Agroquímicos', description: 'Cipermetrina', product: 'Cipermetrina',
        quantity: 10, unit: 'lt', field: 'Alfa', expense_type: 'insumo',
      });
      const offer = await h.send('compré 10 lt de cipermetrina en Alfa, 50 mil');
      expect(h.allButtons(offer).some(b => b.id.startsWith('stock_entry_yes_'))).toBe(false);
    } finally {
      await h.q(`UPDATE users SET plan_id = $2 WHERE id = $1`, [h.userId, (original[0] as { plan_id: number }).plan_id]);
    }
  });

  it('STK-14: add_stock con precio + log_expense del mismo producto → UN solo gasto', async () => {
    h.fakeAgent.enqueue([
      { toolName: 'add_stock', toolInput: { product: 'Clorpirifos', quantity: 20, unit: 'lt', field: 'Alfa', unit_price_ars: 10000 } },
      { toolName: 'log_expense', toolInput: { amount: 200000, category: 'Agroquímicos', description: 'Clorpirifos', field: 'Alfa' } },
    ]);
    await h.send('compré 20 lt de clorpirifos a 10 mil el litro para Alfa');
    const n = await h.q(
      `SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1 AND deleted_at IS NULL AND (description ILIKE '%clorpirifos%' OR product ILIKE '%clorpirifos%')`,
      [h.userId],
    );
    expect((n[0] as { n: number }).n).toBe(1);
  });

  describe('documentos', () => {
    const docHandler = makeDocCallbackHandler(async () => Buffer.from(''));
    const ctx = () => ({ userId: h.userId, phone: h.phone, channel: 'testbot', startTime: Date.now() } as unknown as ChannelContext);
    const extraction = (total: number, lines: Array<{ product: string; total?: number; quantity?: number; unit?: string }>) =>
      ({ supplier: 'Agro SRL', total_amount: total, currency: 'ARS', line_items: lines } as unknown as DocumentExtraction);
    const newDoc = async () => (await h.q(
      `INSERT INTO documents (user_id, document_type, mime_type, file_size_bytes, processing_status, file_hash) VALUES ($1, 'factura', 'image/jpeg', 1, 'completed', md5(random()::text)) RETURNING id`,
      [h.userId],
    ))[0].id as number;
    const expenseCount = async () => Number((await h.q(
      `SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1 AND description LIKE '%Agro SRL%' AND deleted_at IS NULL`, [h.userId]))[0].n);

    it('STK-18 / STK-7: la diferencia con el total va como gasto aparte; renglones sin total caen al total', () => {
      const withVat = buildSuggestedExpenses(extraction(121000, [{ product: 'Glifosato', total: 100000 }]));
      expect(withVat).toHaveLength(2);
      expect(withVat[1].amount).toBe(21000);
      const noTotals = buildSuggestedExpenses(extraction(50000, [{ product: 'Urea', quantity: 10, unit: 'kg' }]));
      expect(noTotals).toHaveLength(1);
      expect(noTotals[0].amount).toBe(50000);
    });

    it('STK-5 / STK-6: el botón de otro documento no guarda el pendiente, y el doble tap no duplica', async () => {
      // Un solo lote para que no pregunte el lote.
      await h.q(`UPDATE plots SET deleted_at = NOW() WHERE field_id = $1`, [betaId]);
      try {
        const docA = await newDoc();
        const docB = await newDoc();
        const ext = extraction(80000, [{ product: 'Herbicida', total: 80000 }]);
        pendingDocumentStore.set(h.phone, { documentId: docB, extraction: ext, suggestedExpenses: buildSuggestedExpenses(ext), timestamp: Date.now() });

        const stale = await docHandler(`doc_expense_yes_${docA}`, ctx());
        expect(JSON.stringify(stale)).toMatch(/otro documento/);
        expect(await expenseCount()).toBe(0);

        await docHandler(`doc_expense_yes_${docB}`, ctx());
        await docHandler(`doc_expense_yes_${docB}`, ctx());
        expect(await expenseCount()).toBe(1);
      } finally {
        await h.q(`UPDATE plots SET deleted_at = NULL WHERE field_id = $1`, [betaId]);
        pendingDocumentStore.clear(h.phone);
      }
    });

    it('STK-16: un renglón de remito sin cantidad no carga "+1 u"', async () => {
      const docR = await newDoc();
      const ext = extraction(0, [{ product: 'Insecticida X' }, { product: 'Coadyuvante', quantity: 5, unit: 'lt' }]);
      pendingDocumentStore.set(h.phone, { documentId: docR, extraction: ext, suggestedExpenses: [], timestamp: Date.now() });
      const out = JSON.stringify(await docHandler(`doc_warehouse_${whAlfa}_${docR}`, ctx()));
      expect(out).toMatch(/Insecticida X: sin cantidad/);
      expect(await item('insecticida x')).toHaveLength(0);
      expect(await item('coadyuvante')).toHaveLength(1);
    });
  });
});
