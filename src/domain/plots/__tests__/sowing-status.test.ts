import { describe, it, expect } from 'vitest';
import { computeUnsownPlots, type PlotForSowing, type ActiveCropForSowing } from '../sowing-status.js';

const plots: PlotForSowing[] = [
  { id: 1, name: 'navial', field_name: 'La barrida', area_hectares: '88' },
  { id: 2, name: 'Norte', field_name: 'La barrida', area_hectares: 33 },
  { id: 3, name: 'Sur', field_name: 'La barrida', area_hectares: 44 },
  { id: 4, name: 'Bajo', field_name: 'El Rehue', area_hectares: null },
];

const crop = (plot_id: number, c: string, sowed: number | null, harvested = false): ActiveCropForSowing => ({
  plot_id, crop: c, sowed_hectares: sowed, harvested_at: harvested ? '2026-04-01' : null,
});

describe('computeUnsownPlots', () => {
  it('un lote sin campaña activa está libre entero', () => {
    const out = computeUnsownPlots(plots, [crop(1, 'soja', null), crop(2, 'maíz', null)]);
    expect(out.map((u) => u.plotName)).toEqual(['Sur', 'Bajo']);
    expect(out[0].freeHa).toBe(44);
    expect(out[0].needsArea).toBe(false);
  });

  it('un lote sin superficie cargada y sin cultivo es libre y pide la superficie', () => {
    const bajo = computeUnsownPlots(plots, []).find((u) => u.plotName === 'Bajo')!;
    expect(bajo.freeHa).toBeNull();
    expect(bajo.needsArea).toBe(true);
  });

  it('siembra parcial en un lote sin superficie: aparece, sin ha libres, pidiendo la superficie', () => {
    const bajo = computeUnsownPlots(plots, [crop(4, 'soja', 20)]).find((u) => u.plotName === 'Bajo')!;
    expect(bajo.sownCrops).toEqual([{ crop: 'soja', ha: 20 }]);
    expect(bajo.freeHa).toBeNull();
    expect(bajo.needsArea).toBe(true);
  });

  it('una siembra de lote entero (sin ha) en un lote sin superficie sigue ocupándolo', () => {
    expect(computeUnsownPlots(plots, [crop(4, 'soja', null)]).find((u) => u.plotName === 'Bajo')).toBeUndefined();
  });

  it('siembra parcial: lo que queda del lote aparece como libre', () => {
    const out = computeUnsownPlots(plots, [crop(1, 'soja', 40), crop(2, 'maíz', null), crop(3, 'trigo', null)]);
    const navial = out.find((u) => u.plotName === 'navial')!;
    expect(navial.freeHa).toBe(48);
    expect(navial.sownCrops).toEqual([{ crop: 'soja', ha: 40 }]);
  });

  it('una siembra sin ha declaradas ocupa el lote entero (mismo criterio que active_crop)', () => {
    const out = computeUnsownPlots(plots, [crop(1, 'soja', 40), crop(1, 'maíz', null)]);
    expect(out.find((u) => u.plotName === 'navial')).toBeUndefined();
  });

  it('una campaña ya cosechada no ocupa el lote', () => {
    const out = computeUnsownPlots(plots, [crop(2, 'maíz', null, true)]);
    const norte = out.find((u) => u.plotName === 'Norte')!;
    expect(norte.freeHa).toBe(33);
    expect(norte.harvestedCrops).toEqual(['maíz']);
  });

  it('menos de media ha de diferencia es redondeo, no superficie libre', () => {
    const out = computeUnsownPlots(plots, [crop(1, 'soja', 87.8)]);
    expect(out.find((u) => u.plotName === 'navial')).toBeUndefined();
  });

  it('todo sembrado → lista vacía', () => {
    const out = computeUnsownPlots(plots.slice(0, 3), [crop(1, 'soja', null), crop(2, 'maíz', 33), crop(3, 'trigo', 44)]);
    expect(out).toEqual([]);
  });
});
