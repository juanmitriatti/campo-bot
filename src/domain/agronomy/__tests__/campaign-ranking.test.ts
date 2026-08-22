import { describe, it, expect } from 'vitest';
import { buildCampaignRanking } from '../campaign-stats.service.js';

/** Fila cruda tal como la devuelve getCampaignTotals (numéricos como string, igual que pg). */
function raw(over: Partial<Record<string, unknown>> = {}) {
  return {
    crop: 'soja', plot_name: 'Norte', field_name: 'La Esperanza',
    season_year: '2025/26', season_type: 'gruesa',
    effective_ha: '100', yield_kg: '350000',
    exp_ars: '1000000', exp_usd: '0', inc_ars: '3000000', inc_usd: '0',
    ...over,
  } as never;
}

describe('buildCampaignRanking — métricas', () => {
  it('margin = ingresos - gastos', () => {
    const r = buildCampaignRanking([raw()], { metric: 'margin' });
    expect(r.rows[0].marginARS).toBe(2_000_000);
    expect(r.rows[0].value).toBe(2_000_000);
  });

  it('kg/ha usa el área sembrada, no la del lote', () => {
    // 350.000 kg sobre 100 ha = 3500 kg/ha
    expect(buildCampaignRanking([raw()], { metric: 'yield_kg_ha' }).rows[0].yieldKgPerHa).toBe(3500);
  });

  it('costo por hectárea y por tonelada', () => {
    const r = buildCampaignRanking([raw()], { metric: 'cost_per_tn' }).rows[0];
    expect(r.costPerHaARS).toBe(10_000);      // 1.000.000 / 100 ha
    expect(r.costPerTnARS).toBe(2857);        // 1.000.000 / 350 tn
  });
});

describe('buildCampaignRanking — orden', () => {
  const rows = [
    raw({ plot_name: 'A', inc_ars: '1000000', exp_ars: '500000' }),  // margen 500k
    raw({ plot_name: 'B', inc_ars: '5000000', exp_ars: '500000' }),  // margen 4.5M
    raw({ plot_name: 'C', inc_ars: '2000000', exp_ars: '500000' }),  // margen 1.5M
  ];

  it('en margen, mayor primero', () => {
    const r = buildCampaignRanking(rows, { metric: 'margin' });
    expect(r.rows.map(x => x.plot)).toEqual(['B', 'C', 'A']);
  });

  it('en costos, MENOR primero — más barato es mejor', () => {
    const byCost = buildCampaignRanking([
      raw({ plot_name: 'caro', exp_ars: '9000000' }),
      raw({ plot_name: 'barato', exp_ars: '1000000' }),
    ], { metric: 'cost_per_ha' });
    expect(byCost.rows.map(x => x.plot)).toEqual(['barato', 'caro']);
  });

  it('top_n recorta después de ordenar', () => {
    const r = buildCampaignRanking(rows, { metric: 'margin', topN: 2 });
    expect(r.rows.map(x => x.plot)).toEqual(['B', 'C']);
  });
});

describe('buildCampaignRanking — agrupado por cultivo', () => {
  it('suma los totales de los lotes del mismo cultivo', () => {
    const r = buildCampaignRanking([
      raw({ crop: 'soja', plot_name: 'A', exp_ars: '1000000', inc_ars: '3000000' }),
      raw({ crop: 'soja', plot_name: 'B', exp_ars: '2000000', inc_ars: '4000000' }),
      raw({ crop: 'maíz', plot_name: 'C', exp_ars: '5000000', inc_ars: '6000000' }),
    ], { groupBy: 'crop', metric: 'margin' });

    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ crop: 'soja', marginARS: 4_000_000 });
    expect(r.rows[1]).toMatchObject({ crop: 'maíz', marginARS: 1_000_000 });
  });

  it('las derivadas salen de los totales, NO del promedio de ratios', () => {
    // 100 ha con 100.000 kg y 300 ha con 900.000 kg.
    // Total: 1.000.000 kg sobre 400 ha = 2500 kg/ha.
    // Promediar ratios (1000 y 3000) daría 2000 — mal.
    const r = buildCampaignRanking([
      raw({ crop: 'soja', effective_ha: '100', yield_kg: '100000' }),
      raw({ crop: 'soja', effective_ha: '300', yield_kg: '900000' }),
    ], { groupBy: 'crop', metric: 'yield_kg_ha' });
    expect(r.rows[0].yieldKgPerHa).toBe(2500);
  });

  it('agrupa sin distinguir mayúsculas', () => {
    const r = buildCampaignRanking([
      raw({ crop: 'Soja' }), raw({ crop: 'soja' }),
    ], { groupBy: 'crop' });
    expect(r.rows).toHaveLength(1);
  });
});

describe('buildCampaignRanking — datos incompletos', () => {
  it('una campaña sin rinde no entra al ranking de kg/ha y se cuenta como omitida', () => {
    const r = buildCampaignRanking([
      raw({ plot_name: 'con', yield_kg: '350000' }),
      raw({ plot_name: 'sin', yield_kg: null }),
    ], { metric: 'yield_kg_ha' });
    expect(r.rows.map(x => x.plot)).toEqual(['con']);
    expect(r.skipped).toBe(1);
  });

  it('sin área no calcula kg/ha ni costo/ha', () => {
    const r = buildCampaignRanking([raw({ effective_ha: null })], { metric: 'margin' }).rows[0];
    expect(r.yieldKgPerHa).toBeNull();
    expect(r.costPerHaARS).toBeNull();
    expect(r.marginARS).toBe(2_000_000); // el margen no depende del área
  });

  it('ignora un rinde negativo en vez de propagarlo', () => {
    // En la DB local hay un plot_crops con yield_kg = -500.
    const r = buildCampaignRanking([raw({ yield_kg: '-500' })], { metric: 'yield_kg_ha' });
    expect(r.rows).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('sin campañas devuelve un ranking vacío, no rompe', () => {
    const r = buildCampaignRanking([], { metric: 'margin' });
    expect(r.rows).toEqual([]);
    expect(r.skipped).toBe(0);
  });

  it('un margen de cero es un valor válido y entra al ranking', () => {
    const r = buildCampaignRanking([raw({ exp_ars: '1000', inc_ars: '1000' })], { metric: 'margin' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].value).toBe(0);
  });
});
