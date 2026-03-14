import { describe, it, expect } from 'vitest';
import { inferCrop, getActivityLabel, formatActivityConfirmation } from '../activity.service.js';
import type { PlotCropRow } from '../../../types/index.js';

describe('inferCrop', () => {
  const makeActiveCrop = (crop: string): PlotCropRow => ({
    id: 1, plot_id: 1, crop, season_year: 2025, season_type: 'gruesa',
    start_date: new Date(), end_date: null, created_at: new Date(),
  });

  it('explicit crop wins over everything', () => {
    const active = makeActiveCrop('Maíz');
    expect(inferCrop('Soja', active, 'Atrazina')).toBe('Soja');
  });

  it('active crop used when no explicit crop', () => {
    const active = makeActiveCrop('Trigo');
    expect(inferCrop(null, active, null)).toBe('Trigo');
  });

  it('product inference: Atrazina → Maíz', () => {
    expect(inferCrop(null, null, 'Atrazina')).toBe('Maíz');
  });

  it('product inference: Imazetapir → Soja', () => {
    expect(inferCrop(null, null, 'Imazetapir')).toBe('Soja');
  });

  it('product inference: Cletodim → Soja', () => {
    expect(inferCrop(null, null, 'Cletodim')).toBe('Soja');
  });

  it('product inference: Haloxifop → Soja', () => {
    expect(inferCrop(null, null, 'Haloxifop')).toBe('Soja');
  });

  it('returns null when nothing infers', () => {
    expect(inferCrop(null, null, null)).toBeNull();
  });

  it('returns null for unknown product', () => {
    expect(inferCrop(null, null, 'Glifosato')).toBeNull();
  });
});

describe('getActivityLabel', () => {
  it('spraying → 💨 Pulverización', () => {
    const r = getActivityLabel('spraying');
    expect(r.label).toBe('Pulverización');
  });

  it('fertilization → 🧪 Fertilización', () => {
    const r = getActivityLabel('fertilization');
    expect(r.label).toBe('Fertilización');
  });

  it('tillage → 🚜 Labranza', () => {
    const r = getActivityLabel('tillage');
    expect(r.label).toBe('Labranza');
  });

  it('irrigation → 💧 Riego', () => {
    const r = getActivityLabel('irrigation');
    expect(r.label).toBe('Riego');
  });

  it('planting → 🌱 Siembra', () => {
    const r = getActivityLabel('planting');
    expect(r.label).toBe('Siembra');
  });

  it('harvest → 🌾 Cosecha', () => {
    const r = getActivityLabel('harvest');
    expect(r.label).toBe('Cosecha');
  });

  it('unknown type returns fallback', () => {
    const r = getActivityLabel('unknown_type');
    expect(r.label).toBe('unknown_type');
  });
});

describe('formatActivityConfirmation', () => {
  it('with product and quantity', () => {
    const msg = formatActivityConfirmation('spraying', 'Norte > Lote 3', {
      product: 'Glifosato',
      productType: 'herbicida',
      quantity: 200,
      unit: 'lt',
    });
    expect(msg).toContain('Pulverización');
    expect(msg).toContain('Norte > Lote 3');
    expect(msg).toContain('Glifosato');
    expect(msg).toContain('herbicida');
    expect(msg).toContain('200 lt');
  });

  it('with implement', () => {
    const msg = formatActivityConfirmation('tillage', 'Norte > Lote 3', {
      implement: 'Cincel',
    });
    expect(msg).toContain('Labranza');
    expect(msg).toContain('Cincel');
  });

  it('minimal data', () => {
    const msg = formatActivityConfirmation('irrigation', 'Lote 3', {});
    expect(msg).toContain('Riego');
    expect(msg).toContain('Lote 3');
  });

  it('with crop', () => {
    const msg = formatActivityConfirmation('fertilization', 'Lote 2', {
      product: 'Urea',
      crop: 'Maíz',
    });
    expect(msg).toContain('Fertilización');
    expect(msg).toContain('Urea');
    expect(msg).toContain('Maíz');
  });
});
