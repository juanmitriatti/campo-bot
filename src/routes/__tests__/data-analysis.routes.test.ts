import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../services/settings.service.js', () => ({
  getSetting: vi.fn(async () => null),
  getSettingNumber: vi.fn(async () => null),
  getSettingBool: vi.fn(async () => true),
}));
vi.mock('../../services/error-logger.js', () => ({ logError: vi.fn() }));

import { pool } from '../../config/db.js';
import { appReachable, registerTestUser, api } from './routes-helpers.js';
import { createDataAnalysisRouter, type DataAnalysisDeps } from '../data-analysis.routes.js';
import { ScopeError, type AnalysisContext } from '../../services/data-analysis-context.service.js';
import { AiQuotaExceededError } from '../../services/ai-quota.service.js';
import { campaignRange } from '../../utils/campaign-range.js';

/**
 * Ruta in-process con fakes: sin Anthropic, sin DB. Lo que se prueba acá es
 * el CONTRATO HTTP (validación, códigos, forma del JSON). El 200 real contra
 * Claude queda en la verificación manual (no hay seam en el server real).
 */

const ctx = (): AnalysisContext => ({
  meta: { campaign: '25/26', from: '2025-09-01', to: '2026-08-31', scope: 'field', fields: [{ id: 3, name: 'La Esperanza' }], plots: [{ id: 10, name: 'Lote 1', field: 'La Esperanza', ha: 40, crop: 'Soja' }], columns: {} as AnalysisContext['meta']['columns'], notes: [] },
  summary: {} as AnalysisContext['summary'],
  plots: [], campaignStats: [], expenses: [], incomes: [], events: [], harvestLoads: [], rainfall: [], stock: [], livestockGroups: [],
  truncation: [{ list: 'events', kept: 75, total: 212 }],
});

function makeDeps(over: Partial<DataAnalysisDeps> = {}): DataAnalysisDeps & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { analyze: [], buildContext: [] };
  const deps: DataAnalysisDeps = {
    buildContext: async (scope, limits) => { calls.buildContext.push({ scope, limits }); return { context: ctx(), json: '{"x":1}' }; },
    analyze: async (userId, args) => {
      calls.analyze.push({ userId, args });
      return { answer: '## Ok\n\n| a | b |\n|---|---|\n| 1 | 2 |', usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 }, model: 'claude-sonnet-5', truncated: false, stopReason: 'end_turn', costUsd: 0.001 };
    },
    assertQuota: async () => ({ used: 4, limit: 100, remaining: 96, exhausted: false, planName: 'pro' }),
    getQuota: async () => ({ used: 4, limit: 100, remaining: 96, exhausted: false, planName: 'pro' }),
    resolvePlots: async (_u, _f, ids) => ids,
    fieldAccessible: async (_u, fieldId) => fieldId !== 999,
    resolveFields: async (_u, fieldId) => (fieldId == null ? [3, 4] : [fieldId]),
    auth: (req, _res, next) => { (req as unknown as { auth: { userId: number } }).auth = { userId: 1 }; next(); },
    feature: (_req, _res, next) => next(),
    ...over,
  };
  return Object.assign(deps, { calls });
}

let server: Server;
let base = '';
let deps = makeDeps();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // El router se resuelve por request para poder cambiar los fakes por test.
  app.use('/api/auth', (req, res, next) => createDataAnalysisRouter(deps)(req, res, next));
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { deps = makeDeps(); });

async function post(body: unknown) {
  const r = await fetch(`${base}/data-analysis`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

describe('POST /api/auth/data-analysis — contrato HTTP', () => {
  it('200: forma exacta del JSON, cuota +1, alcance y recortes del contexto', async () => {
    const { status, json } = await post({ field_id: 3, plot_ids: [10], question: '¿Qué gasto creció?', season: 2025 });
    expect(status).toBe(200);
    expect(json).toEqual({
      answer: expect.stringContaining('## Ok'),
      model: 'claude-sonnet-5',
      scope: { campaign: campaignRange(2025).label, from: '2025-09-01', to: '2026-08-31', fieldIds: [3], plotIds: [10], fieldNames: ['La Esperanza'], plotNames: ['Lote 1'] },
      truncated: [{ list: 'events', kept: 75, total: 212 }],
      quota: { used: 5, limit: 100, remaining: 95 },
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
    });
    const call = deps.calls.buildContext[0] as { scope: { includeUnassigned: boolean; plotIds: number[] | null } };
    expect(call.scope.includeUnassigned).toBe(false);
    expect(call.scope.plotIds).toEqual([10]);
    const a = deps.calls.analyze[0] as { args: { scopeLabel: string; dataJson: string } };
    expect(a.args.dataJson).toBe('{"x":1}');
    expect(a.args.scopeLabel).toContain('La Esperanza');
  });

  it('"all" incluye lo sin ubicación y no admite plot_ids', async () => {
    const ok = await post({ field_id: 'all', question: 'resumen' });
    expect(ok.status).toBe(200);
    expect((deps.calls.buildContext[0] as { scope: { includeUnassigned: boolean } }).scope.includeUnassigned).toBe(true);

    const bad = await post({ field_id: 'all', plot_ids: [1], question: 'resumen' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('PLOT_IDS_WITHOUT_FIELD');
  });

  it('400 en cada validación, con código y mensaje en castellano', async () => {
    expect((await post({ field_id: 'x', question: 'q' })).json.code).toBe('FIELD_ID_INVALID');
    expect((await post({ field_id: 3, question: '   ' })).json.code).toBe('QUESTION_REQUIRED');
    expect((await post({ field_id: 3, question: 'q'.repeat(1001) })).json.code).toBe('QUESTION_TOO_LONG');
    expect((await post({ field_id: 3, plot_ids: 'no', question: 'q' })).json.code).toBe('PLOT_IDS_INVALID');
    expect((await post({ field_id: 3, plot_ids: [1, -2], question: 'q' })).json.code).toBe('PLOT_IDS_INVALID');
    expect((await post({ field_id: 3, question: 'q', history: [{ role: 'system', content: 'x' }] })).json.code).toBe('HISTORY_INVALID');
    expect((await post({ field_id: 3, question: 'q', history: Array(13).fill({ role: 'user', content: 'x' }) })).json.code).toBe('HISTORY_TOO_LONG');
    const r = await post({ field_id: 3, question: '' });
    expect(String(r.json.error)).toMatch(/Escribí/);
    expect(deps.calls.analyze).toHaveLength(0);
  });

  it('404 campo ajeno; 400 lote fuera de alcance (ScopeError del assembler)', async () => {
    expect((await post({ field_id: 999, question: 'q' })).status).toBe(404);
    deps = makeDeps({ resolvePlots: async () => { throw new ScopeError('Los lotes 77 no pertenecen a los campos elegidos.'); } });
    const r = await post({ field_id: 3, plot_ids: [77], question: 'q' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('PLOT_NOT_IN_SCOPE');
  });

  it('429 cuando la cuota diaria se agotó, con la cuota en el cuerpo y sin llamar a la IA', async () => {
    deps = makeDeps({ assertQuota: async () => { throw new AiQuotaExceededError({ used: 100, limit: 100, remaining: 0, exhausted: true, planName: 'pro' }); } });
    const r = await post({ field_id: 3, question: 'q' });
    expect(r.status).toBe(429);
    expect(r.json).toMatchObject({ code: 'AI_QUOTA_EXCEEDED', quota: { used: 100, limit: 100, remaining: 0 } });
    expect(String(r.json.error)).toContain('tope diario');
    expect(deps.calls.analyze).toHaveLength(0);
  });

  it('503 honesto cuando la IA está apagada o falla (analyze → null)', async () => {
    deps = makeDeps({ analyze: async () => null });
    const r = await post({ field_id: 3, question: 'q' });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('AI_UNAVAILABLE');
  });

  it('GET /quota devuelve el cupo del día', async () => {
    const r = await fetch(`${base}/data-analysis/quota`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ quota: { used: 4, limit: 100, remaining: 96 } });
  });
});

/**
 * Contra el server real de :3000 (se salta si no está): gate de plan, lote
 * ajeno y cuota agotada. El 200 con Claude no se prueba acá (créditos).
 */
describe('POST /api/auth/data-analysis — server real', () => {
  let appUp = false;
  let ctx: { token: string; userId: number; call: ReturnType<typeof api> } | null = null;
  let other: { token: string; userId: number } | null = null;
  let fieldId = 0;
  let otherPlotId = 0;

  beforeAll(async () => {
    appUp = await appReachable();
    if (!appUp) return;
    const u = await registerTestUser('dataan');
    ctx = { ...u, call: api(u.token) };
    other = await registerTestUser('dataan-other');
    const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo DA') RETURNING id`, [u.userId]);
    fieldId = f.rows[0].id as number;
    const of = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'Campo ajeno') RETURNING id`, [other.userId]);
    const op = await pool.query(`INSERT INTO plots (field_id, name) VALUES ($1, 'Ajeno 1') RETURNING id`, [of.rows[0].id]);
    otherPlotId = op.rows[0].id as number;
  });

  afterAll(async () => {
    if (!appUp) return;
    for (const uid of [ctx?.userId, other?.userId]) {
      if (!uid) continue;
      await pool.query(`DELETE FROM ai_usage WHERE user_id = $1`, [uid]).catch(() => {});
      await pool.query(`DELETE FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`, [uid]).catch(() => {});
      await pool.query(`DELETE FROM field_members WHERE user_id = $1`, [uid]).catch(() => {});
      await pool.query(`DELETE FROM fields WHERE user_id = $1`, [uid]).catch(() => {});
      await pool.query(`DELETE FROM subscriptions WHERE user_id = $1`, [uid]).catch(() => {});
      await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [uid]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id = $1`, [uid]).catch(() => {});
    }
  });

  it('plan free → 403 (la feature es Pro); plan pro → pasa el gate', async () => {
    if (!appUp || !ctx) return;
    await pool.query(`UPDATE users SET plan_id = (SELECT id FROM plans WHERE name = 'free') WHERE id = $1`, [ctx.userId]);
    const forbidden = await ctx.call('/data-analysis/quota');
    expect(forbidden.status).toBe(403);

    await pool.query(`UPDATE users SET plan_id = (SELECT id FROM plans WHERE name = 'pro') WHERE id = $1`, [ctx.userId]);
    const ok = await ctx.call('/data-analysis/quota');
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.quota.limit).toBeGreaterThan(0);
  });

  it('lote de otro usuario → 400 PLOT_NOT_IN_SCOPE, sin gastar cuota', async () => {
    if (!appUp || !ctx) return;
    const r = await ctx.call('/data-analysis', {
      method: 'POST',
      body: JSON.stringify({ field_id: fieldId, plot_ids: [otherPlotId], question: '¿qué pasó?' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('PLOT_NOT_IN_SCOPE');
    const used = await pool.query(`SELECT COUNT(*)::int AS n FROM ai_usage WHERE user_id = $1`, [ctx.userId]);
    expect(Number(used.rows[0].n)).toBe(0);
  });

  it('cuota del día agotada → 429 antes de armar datos o llamar a la IA', async () => {
    if (!appUp || !ctx) return;
    const lim = await pool.query(`SELECT p.daily_ai_limit FROM plans p JOIN users u ON u.plan_id = p.id WHERE u.id = $1`, [ctx.userId]);
    const limit = Number(lim.rows[0].daily_ai_limit ?? 50);
    await pool.query(
      `INSERT INTO ai_usage (user_id, input_tokens, output_tokens, total_tokens)
       SELECT $1, 1, 1, 2 FROM generate_series(1, $2::int)`,
      [ctx.userId, limit],
    );
    const r = await ctx.call('/data-analysis', {
      method: 'POST',
      body: JSON.stringify({ field_id: 'all', question: '¿qué pasó?' }),
    });
    expect(r.status).toBe(429);
    const body = await r.json();
    expect(body.code).toBe('AI_QUOTA_EXCEEDED');
    expect(body.quota.remaining).toBe(0);
  });
});
