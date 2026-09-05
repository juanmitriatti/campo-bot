import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../testing/integration/pipeline-harness.js';
import { getOverview } from '../overview.service.js';
import { getReviewFindings } from '../review-findings.service.js';
import { campaignRange } from '../../utils/campaign-range.js';

/**
 * Regresiones del Resumen (Sep 2026). Cada test acá es un número que el
 * dashboard mostró MAL en la copia de prod:
 *
 * - ventas de grano sin campo ni lote que no entraban al resultado de campaña;
 * - "12 animales en total" para un rodeo de 960 cabezas en 12 grupos;
 * - "cosecha antes que su siembra" disparando en una rotación soja→soja normal;
 * - la tarjeta del lote mostrando el cultivo de HOY al mirar la campaña pasada.
 */

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

// Campaña 25/26: 1 sep 2025 → 31 ago 2026.
const RANGE = campaignRange(2025);

describe.skipIf(!dbAvailable)('overview.service — scoping del Resumen', () => {
  let h: PipelineHarness;
  let fieldA: number;
  let fieldB: number;
  let plotA: number;

  beforeAll(async () => {
    h = await createPipelineHarness('overview-scope');
    const fa = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Overview A') RETURNING id`, [h.userId]);
    fieldA = fa[0].id as number;
    const fb = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Overview B') RETURNING id`, [h.userId]);
    fieldB = fb[0].id as number;
    const pa = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Lote 1', 50) RETURNING id`, [fieldA]);
    plotA = pa[0].id as number;

    // Un gasto en el lote, un gasto a nivel campo B, y una venta de soja SIN
    // campo ni lote (como las 37 de la copia de prod).
    await h.q(
      `INSERT INTO expenses (user_id, category, description, amount, currency, field_id, plot_id, expense_date)
       VALUES ($1, 'Combustible', 'gasoil', 100000, 'ARS', $2, $3, '2026-01-10')`,
      [h.userId, fieldA, plotA],
    );
    await h.q(
      `INSERT INTO expenses (user_id, category, description, amount, currency, field_id, plot_id, expense_date)
       VALUES ($1, 'Sueldos', 'peón', 50000, 'ARS', $2, NULL, '2026-02-10')`,
      [h.userId, fieldB],
    );
    await h.q(
      `INSERT INTO incomes (user_id, category, description, amount, currency, field_id, plot_id, income_date, product, quantity, unit)
       VALUES ($1, 'Soja', 'venta a Cargill', 30000, 'USD', NULL, NULL, '2026-05-20', 'Soja', 100, 'tn')`,
      [h.userId],
    );

    // 12 grupos chicos: 960 cabezas, no 12.
    for (let i = 0; i < 12; i++) {
      await h.q(
        `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
         VALUES ($1, $2, $3, 'vaca', 'Angus ${i}', 80)`,
        [h.userId, fieldA, plotA],
      );
    }

    // Cultivo sembrado en 25/26, todavía activo.
    await h.q(
      `INSERT INTO plot_crops (plot_id, crop, season_year, start_date) VALUES ($1, 'Soja', 2025, '2025-11-10')`,
      [plotA],
    );
  });

  afterAll(async () => { await h?.cleanup(); });

  it('con "Todos los campos" entra la venta sin campo ni lote', async () => {
    const all = await getOverview(Number(h.userId), [fieldA, fieldB], RANGE, { includeUnassigned: true });
    expect(all.money.USD.income).toBe(30000);
    expect(all.money.USD.incomeCount).toBe(1);
    expect(all.money.ARS.expense).toBe(150000);
    expect(all.counts.incomes).toBe(1);
    // …y la fila aparece en "qué vendiste" con toneladas y precio por tn.
    const soja = all.incomeProducts.USD.find(r => r.name === 'Soja');
    expect(soja?.kg).toBe(100000);
    expect(soja?.pricePerTn).toBe(300);
  });

  it('con un campo puntual NO entra lo que no tiene ubicación', async () => {
    const one = await getOverview(Number(h.userId), [fieldA], RANGE, { includeUnassigned: false });
    expect(one.money.USD.income).toBe(0);
    expect(one.money.ARS.expense).toBe(100000);
  });

  it('counts.livestock son cabezas, no grupos', async () => {
    const all = await getOverview(Number(h.userId), [fieldA, fieldB], RANGE, { includeUnassigned: true });
    expect(all.counts.livestock).toBe(960);
    expect(all.livestock.total).toBe(960);
    expect(all.livestock.byCategory).toEqual([{ category: 'vaca', count: 960 }]);
    // y respeta el campo elegido
    const b = await getOverview(Number(h.userId), [fieldB], RANGE, { includeUnassigned: false });
    expect(b.counts.livestock).toBe(0);
  });

  it('el cultivo del lote es el de la campaña elegida, no el de hoy', async () => {
    const now = await getOverview(Number(h.userId), [fieldA], RANGE, { includeUnassigned: false });
    expect(now.plots[0].crop).toBe('Soja');
    // Campaña 24/25 (sep 2024 → ago 2025): la soja de nov 2025 todavía no existía.
    const prev = await getOverview(Number(h.userId), [fieldA], campaignRange(2024), { includeUnassigned: false });
    expect(prev.plots[0].crop).toBeNull();
  });

  it('el margen por cultivo y el $/ha salen de las mismas tarjetas', async () => {
    const one = await getOverview(Number(h.userId), [fieldA], RANGE, { includeUnassigned: false });
    const soja = one.cropMargins.ARS.find(r => r.crop === 'Soja');
    expect(soja).toMatchObject({ hectares: 50, plots: 1, expense: 100000, income: 0 });
  });
});

describe.skipIf(!dbAvailable)('review-findings — cosecha antes que su siembra', () => {
  let h: PipelineHarness;
  let fieldId: number;
  let plotId: number;

  const ctx = () => ({ userId: Number(h.userId), fieldIds: [fieldId], range: RANGE });
  const rule = async () => (await getReviewFindings(ctx())).filter(f => f.rule === 'harvest_before_planting');

  beforeAll(async () => {
    h = await createPipelineHarness('review-harvest');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Rotación') RETURNING id`, [h.userId]);
    fieldId = f[0].id as number;
    const p = await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Grande', 100) RETURNING id`, [fieldId]);
    plotId = p[0].id as number;
  });

  afterAll(async () => { await h?.cleanup(); });

  it('una rotación soja → cosecha → soja de nuevo NO es un error', async () => {
    await h.q(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, crop) VALUES
         ($1, $2, 'planting', '2025-11-10', 'soja'),
         ($1, $2, 'harvest',  '2026-04-14', 'soja'),
         ($1, $2, 'planting', '2026-04-15', 'soja')`,
      [h.userId, plotId],
    );
    expect(await rule()).toEqual([]);
  });

  it('una cosecha sin ninguna siembra anterior y con una posterior SÍ se reporta', async () => {
    await h.q(
      `INSERT INTO domain_events (user_id, plot_id, event_type, event_date, crop) VALUES
         ($1, $2, 'harvest',  '2026-01-20', 'maíz'),
         ($1, $2, 'planting', '2026-02-01', 'maíz')`,
      [h.userId, plotId],
    );
    const found = await rule();
    expect(found).toHaveLength(1);
    expect(found[0].body).toContain('maíz');
  });
});
