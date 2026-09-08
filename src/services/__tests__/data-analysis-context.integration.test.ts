import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pool } from '../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../testing/integration/pipeline-harness.js';
import { campaignRange } from '../../utils/campaign-range.js';
import {
  buildAnalysisContext, resolvePlotIds, shrinkToBudget, ScopeError, SACRIFICE_ORDER,
  type AnalysisContext,
} from '../data-analysis-context.service.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

const RANGE = campaignRange(2025); // 1 sep 2025 → 31 ago 2026

/** Un contexto mínimo con listas de N filas, para probar el recorte sin DB. */
function ctxWith(rows: Partial<Record<(typeof SACRIFICE_ORDER)[number], number>>): AnalysisContext {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => [`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, i * 1000.5, 'ARS', 'Gasoil', 'fila muy descriptiva para ocupar bytes', 'Lote 1', null, null, null]);
  return {
    meta: { campaign: '25/26', from: RANGE.from, to: RANGE.to, scope: 'field', fields: [], plots: [], columns: {} as AnalysisContext['meta']['columns'], notes: [] },
    summary: {} as AnalysisContext['summary'],
    plots: [],
    campaignStats: [],
    expenses: mk(rows.expenses ?? 0),
    incomes: mk(rows.incomes ?? 0),
    events: mk(rows.events ?? 0),
    harvestLoads: mk(rows.harvestLoads ?? 0),
    rainfall: mk(rows.rainfall ?? 0),
    stock: mk(rows.stock ?? 0),
    livestockGroups: mk(rows.livestockGroups ?? 0),
    truncation: [],
  };
}

describe('shrinkToBudget — recorte determinístico, en orden fijo, nunca en silencio', () => {
  it('recorta events antes que expenses, a la mitad por paso, y lo registra', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = ctxWith({ events: 120, expenses: 120, incomes: 40 });
    const full = JSON.stringify(ctx).length;
    const { context, json } = shrinkToBudget(ctx, Math.floor(full * 0.6), { events: 120, expenses: 120, incomes: 40 }, 9);

    expect(json.length).toBeLessThanOrEqual(Math.floor(full * 0.6));
    expect(context.events.length).toBeLessThan(120);
    expect(context.truncation[0].list).toBe('events');
    expect(context.truncation[0]).toMatchObject({ total: 120 });
    // Cada corte quedó logueado con el usuario.
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('[data-analysis] TRUNCATE user=9 list=events'))).toBe(true);
    logSpy.mockRestore();
  });

  it('no baja de 20 filas por lista y, si no queda nada que recortar, lo dice y devuelve lo que hay', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = ctxWith({ events: 25, expenses: 25 });
    const { context, json } = shrinkToBudget(ctx, 500, {}, 9);
    expect(context.events.length).toBe(20);
    expect(context.expenses.length).toBe(20);
    expect(json.length).toBeGreaterThan(500);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('no queda nada que recortar'))).toBe(true);
    logSpy.mockRestore();
  });

  it('sin exceso no toca nada ni anota recortes', () => {
    const ctx = ctxWith({ events: 30 });
    const { context } = shrinkToBudget(ctx, 10_000_000, {}, 9);
    expect(context.events).toHaveLength(30);
    expect(context.truncation).toEqual([]);
  });
});

describe.skipIf(!dbAvailable)('buildAnalysisContext — alcance, aislamiento y determinismo', () => {
  let a: PipelineHarness;
  let b: PipelineHarness;
  let fieldA: number;
  let plotA1: number;
  let plotA2: number;
  let fieldB: number;
  let plotB: number;

  beforeAll(async () => {
    a = await createPipelineHarness('analysis-ctx-a');
    b = await createPipelineHarness('analysis-ctx-b');
    const fa = await a.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo A') RETURNING id`, [a.userId]);
    fieldA = fa[0].id as number;
    plotA1 = (await a.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'A1', 40) RETURNING id`, [fieldA]))[0].id as number;
    plotA2 = (await a.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'A2', 60) RETURNING id`, [fieldA]))[0].id as number;
    const fb = await b.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo B') RETURNING id`, [b.userId]);
    fieldB = fb[0].id as number;
    plotB = (await b.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'B1') RETURNING id`, [fieldB]))[0].id as number;

    for (let i = 0; i < 8; i++) {
      await a.q(
        `INSERT INTO expenses (user_id, category, description, amount, currency, field_id, plot_id, expense_date)
         VALUES ($1, 'Combustible', $2, $3, 'ARS', $4, $5, $6)`,
        [a.userId, `gasoil ${i}`, 1000 * (i + 1), fieldA, i < 5 ? plotA1 : plotA2, `2025-11-${String(i + 1).padStart(2, '0')}`],
      );
    }
    await a.q(
      `INSERT INTO incomes (user_id, category, description, amount, currency, field_id, plot_id, income_date, product, quantity, unit)
       VALUES ($1, 'Soja', 'venta', 50000, 'USD', $2, $3, '2026-05-10', 'soja', 100, 'tn')`,
      [a.userId, fieldA, plotA1],
    );
    await b.q(
      `INSERT INTO expenses (user_id, category, description, amount, currency, field_id, plot_id, expense_date)
       VALUES ($1, 'Combustible', 'SECRETO DE B', 999999, 'ARS', $2, $3, '2025-12-01')`,
      [b.userId, fieldB, plotB],
    );
  });
  afterAll(async () => { await a?.cleanup(); await b?.cleanup(); });

  it('los datos de otro usuario no aparecen, y el JSON es idéntico byte a byte entre dos llamadas', async () => {
    const scope = { userId: Number(a.userId), fieldIds: [fieldA], plotIds: null, includeUnassigned: false, range: RANGE };
    const one = await buildAnalysisContext(scope, { maxRowsPerList: 150, maxChars: 60000 });
    const two = await buildAnalysisContext(scope, { maxRowsPerList: 150, maxChars: 60000 });

    expect(one.json).not.toContain('SECRETO DE B');
    expect(one.context.expenses).toHaveLength(8);
    expect(one.context.incomes).toHaveLength(1);
    expect(one.context.meta.scope).toBe('field');
    expect(one.context.meta.plots.map((p) => p.name).sort()).toEqual(['A1', 'A2']);
    expect(one.json).toBe(two.json);
  });

  it('con lotes elegidos las listas se acotan y el summary sigue siendo del campo (meta.notes lo dice)', async () => {
    const scope = { userId: Number(a.userId), fieldIds: [fieldA], plotIds: [plotA2], includeUnassigned: false, range: RANGE };
    const { context } = await buildAnalysisContext(scope, { maxRowsPerList: 150, maxChars: 60000 });
    expect(context.meta.scope).toBe('plots');
    expect(context.expenses).toHaveLength(3);
    expect(context.incomes).toHaveLength(0);
    expect(context.plots.map((p) => p.name)).toEqual(['A2']);
    expect(context.summary.money.ARS.expense).toBe(36000); // los 8 gastos del campo
    expect(context.meta.notes.join(' ')).toMatch(/acotadas a los lotes/);
  });

  it('el tope de filas recorta las más viejas y lo anota en truncation con el total real', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const scope = { userId: Number(a.userId), fieldIds: [fieldA], plotIds: null, includeUnassigned: false, range: RANGE };
    const { context } = await buildAnalysisContext(scope, { maxRowsPerList: 5, maxChars: 60000 });
    expect(context.expenses).toHaveLength(5);
    expect(context.expenses[0][0]).toBe('2025-11-08'); // más reciente primero
    expect(context.truncation).toContainEqual({ list: 'expenses', kept: 5, total: 8 });
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('TRUNCATE') && String(c[0]).includes('list=expenses kept=5/8'))).toBe(true);
    logSpy.mockRestore();
  });

  it('resolvePlotIds rechaza un lote de otro usuario con 400 y acepta los propios', async () => {
    await expect(resolvePlotIds(Number(a.userId), [fieldA], [plotA1, plotB])).rejects.toBeInstanceOf(ScopeError);
    await expect(resolvePlotIds(Number(a.userId), [fieldA], [plotA1, plotA1])).resolves.toEqual([plotA1]);
    // Un lote propio pero de OTRO campo tampoco entra en el alcance pedido.
    await expect(resolvePlotIds(Number(a.userId), [fieldA + 100000], [plotA1])).rejects.toBeInstanceOf(ScopeError);
  });
});
