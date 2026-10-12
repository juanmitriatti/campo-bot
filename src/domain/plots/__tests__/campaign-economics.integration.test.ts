import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../../testing/integration/pipeline-harness.js';
import { getCampaignMoney, getCampaignTotals } from '../../../services/expenses.js';
import { getOverview } from '../../../services/overview.service.js';
import { getRate } from '../../../services/fx-rate.service.js';
import { CampaignStatsService } from '../../agronomy/campaign-stats.service.js';
import { campaignRange } from '../../../utils/campaign-range.js';

/**
 * La campaña como unidad económica (análisis de cosecha, 12 oct 2026).
 * Cada test es un número que el bot o el Resumen daban mal:
 *   - el barbecho previo a la siembra no era costo de la campaña;
 *   - el grano vendido después del cierre no era ingreso de la campaña;
 *   - lo cargado a nivel campo no era de ninguna campaña;
 *   - el trigo sembrado en junio caía en la campaña anterior del Resumen;
 *   - trigo + soja de 2da no existía (la soja "reemplazaba" al trigo);
 *   - pesos y dólares nunca se sumaban.
 */

let dbAvailable = true;
try { await pool.query('SELECT 1'); } catch { dbAvailable = false; }

describe.skipIf(!dbAvailable)('campaign-money — qué plata es de qué campaña', () => {
  let h: PipelineHarness;
  let fieldId: number;
  let uno: number;
  let dos: number;
  let trigo: number;
  let soja2da: number;
  let sojaDos: number;

  const exp = (cat: string, amount: number, date: string, plot: number | null, currency = 'ARS') =>
    h.q(`INSERT INTO expenses (user_id, category, description, amount, currency, field_id, plot_id, expense_date)
         VALUES ($1, $2, $8, $3, $4, $5, $6, $7) RETURNING id`, [h.userId, cat, amount, currency, fieldId, plot, date, cat]);
  const inc = (cat: string, amount: number, date: string, plot: number | null, field: number | null, currency = 'USD') =>
    h.q(`INSERT INTO incomes (user_id, category, description, amount, currency, field_id, plot_id, income_date, product)
         VALUES ($1, $2, 'venta', $3, $4, $5, $6, $7, $8) RETURNING id`, [h.userId, cat, amount, currency, field, plot, date, cat]);

  beforeAll(async () => {
    h = await createPipelineHarness('campaign-money');
    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Economía') RETURNING id`, [h.userId]);
    fieldId = f[0].id as number;
    uno = (await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Uno', 100) RETURNING id`, [fieldId]))[0].id as number;
    dos = (await h.q(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Dos', 100) RETURNING id`, [fieldId]))[0].id as number;

    // Lote Uno: trigo 2025 (jun → cosecha 5 dic) y soja de 2da (15 dic → 20 abr).
    trigo = (await h.q(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, harvested_at, end_date, yield_kg, crop_order)
       VALUES ($1, 'Trigo', 2025, 'fina', '2025-06-10', '2025-12-05', '2025-12-15', 350000, 1) RETURNING id`, [uno]))[0].id as number;
    soja2da = (await h.q(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, harvested_at, yield_kg, crop_order)
       VALUES ($1, 'Soja', 2025, 'gruesa', '2025-12-15', '2026-04-20', 300000, 2) RETURNING id`, [uno]))[0].id as number;
    // Lote Dos: soja de primera.
    sojaDos = (await h.q(
      `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, harvested_at, yield_kg, crop_order)
       VALUES ($1, 'Soja', 2025, 'gruesa', '2025-11-01', '2026-04-10', 400000, 1) RETURNING id`, [dos]))[0].id as number;

    await exp('Agroquímicos', 100000, '2025-05-01', uno);   // barbecho del trigo (antes de sembrar)
    await exp('Fertilizantes', 200000, '2025-07-01', uno);  // en el trigo
    await exp('Flete', 50000, '2025-12-10', uno);           // flete del trigo, después de cosechar
    await exp('Semillas', 300000, '2025-12-14', uno);       // semilla de la soja 2da, antes de sembrarla
    await exp('Arrendamiento', 400000, '2025-11-20', null); // nivel campo
    await inc('Trigo', 70000, '2026-02-10', uno, fieldId);  // trigo guardado y vendido después del cierre
    await inc('Soja', 140000, '2026-08-15', null, null);    // soja vendida sin lote ni campo
  });

  afterAll(async () => { await h?.cleanup(); });

  const sum = (rows: Array<{ amount: unknown }>) => Math.round(rows.reduce((a, r) => a + Number(r.amount), 0));

  it('el barbecho previo y el flete posterior son del trigo; la semilla de la soja 2da, de la soja', async () => {
    const t = await getCampaignMoney(Number(h.userId), trigo);
    const cats = t.expenses.map(e => e.category).sort();
    expect(cats).toEqual(['Agroquímicos', 'Arrendamiento', 'Fertilizantes', 'Flete']);
    const s = await getCampaignMoney(Number(h.userId), soja2da);
    expect(s.expenses.map(e => e.category)).toEqual(['Semillas']);
  });

  it('el arrendamiento de nivel campo se reparte por ha entre las campañas del momento', async () => {
    const t = await getCampaignMoney(Number(h.userId), trigo);
    const d = await getCampaignMoney(Number(h.userId), sojaDos);
    const arrT = t.expenses.find(e => e.category === 'Arrendamiento');
    const arrD = d.expenses.find(e => e.category === 'Arrendamiento');
    expect(Number(arrT?.amount)).toBe(200000);
    expect(Number(arrD?.amount)).toBe(200000);
  });

  it('el trigo vendido después del cierre es ingreso del trigo', async () => {
    const t = await getCampaignMoney(Number(h.userId), trigo);
    expect(sum(t.incomes)).toBe(70000);
  });

  it('la soja vendida sin lote se reparte por kilos cosechados entre las sojas', async () => {
    const s2 = await getCampaignMoney(Number(h.userId), soja2da);
    const s1 = await getCampaignMoney(Number(h.userId), sojaDos);
    expect(sum(s2.incomes)).toBe(60000); // 300 de 700 tn
    expect(sum(s1.incomes)).toBe(80000); // 400 de 700 tn
  });

  it('getCampaignTotals (ranking) suma lo mismo que la campaña sola', async () => {
    const rows = await getCampaignTotals(Number(h.userId), {});
    const t = rows.find(r => r.id === trigo)!;
    expect(Math.round(Number(t.exp_ars))).toBe(100000 + 200000 + 50000 + 200000);
    expect(Math.round(Number(t.inc_usd))).toBe(70000);
    expect(t.crop_order).toBe(1);
  });

  it('el Resumen 25/26 incluye el barbecho de mayo del trigo y separa Trigo / Soja 2da / Soja', async () => {
    const ov = await getOverview(Number(h.userId), [fieldId], campaignRange(2025), { includeUnassigned: false });
    // El barbecho (1 may 2025) está fuera de la ventana sep–ago pero es del trigo 25/26.
    expect(ov.money.ARS.expense).toBe(100000 + 200000 + 50000 + 300000 + 400000);
    expect(ov.money.USD.income).toBe(70000 + 140000);
    const crops = ov.cropMargins.USD.map(r => r.crop).sort();
    expect(crops).toEqual(['Soja', 'Soja 2da', 'Trigo']);
    const unoCard = ov.plots.find(p => p.id === uno)!;
    expect(unoCard.crop).toBe('Trigo → Soja 2da');
    // Y la campaña anterior ya no se queda con ese barbecho.
    const prev = await getOverview(Number(h.userId), [fieldId], campaignRange(2024), { includeUnassigned: false });
    expect(prev.money.ARS.expense).toBe(0);
  });

  it('todo en dólares: cada peso al dólar de SU fecha', async () => {
    // Una cotización por fecha usada (si la base ya tiene la real, se respeta).
    const dates = ['2025-05-01', '2025-07-01', '2025-12-10', '2025-12-14', '2025-11-20'];
    for (const [i, d] of dates.entries()) {
      await pool.query(
        `INSERT INTO fx_rates (source, rate_date, sell) VALUES ('mayorista', $1, $2) ON CONFLICT DO NOTHING`,
        [d, 1000 + i * 100],
      );
    }
    const t = await getCampaignMoney(Number(h.userId), trigo);
    let expected = 0;
    for (const e of t.expenses) {
      const r = await getRate(String(e.money_date instanceof Date ? e.money_date.toISOString().slice(0, 10) : e.money_date).slice(0, 10), 'mayorista');
      expected += Number(e.amount) / r!.sell;
    }
    const eqSum = t.expenses.reduce((a, e) => a + Number(e.usd_eq), 0);
    expect(Math.round(eqSum)).toBe(Math.round(expected));

    const stats = await new CampaignStatsService().getCampaignStats(h.userId, 'Uno', 'Economía', 'trigo', null);
    if (typeof stats === 'string') throw new Error(stats);
    expect(stats.profitability.incomesUSDEq).toBe(70000);
    expect(stats.profitability.netUSDEq).toBe(Math.round(70000 - expected));
    expect(stats.seasonLabel).toBe('2025/26');
    expect(stats.attribution.preSowingCount).toBe(1);
    expect(stats.attribution.afterCloseCount).toBe(1);
    expect(stats.doubleCrop?.otherCrop).toBe('Soja');
    expect(stats.doubleCrop?.otherOrder).toBe(2);
  });
});
