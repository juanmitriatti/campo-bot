import { describe, it, expect } from 'vitest';
import { computeCategoryMovers, formatMoversLines } from './monthly-insights.js';

const fmt = (n) => `$${Math.round(n).toLocaleString('es-AR')}`;

describe('computeCategoryMovers', () => {
  it('detecta suba relevante', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Gasoil', total: 590000 }],
      [{ category: 'Gasoil', total: 500000 }],
    );
    expect(movers).toHaveLength(1);
    expect(movers[0]).toMatchObject({ category: 'Gasoil', pct: 18 });
  });

  it('detecta baja relevante', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Semillas', total: 400000 }],
      [{ category: 'Semillas', total: 800000 }],
    );
    expect(movers[0].pct).toBe(-50);
  });

  it('filtra variaciones chicas (< minPct)', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Gasoil', total: 505000 }],
      [{ category: 'Gasoil', total: 500000 }],
    );
    expect(movers).toHaveLength(0);
  });

  it('filtra montos chicos (< minAmountArs) aunque el % sea grande', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Varios', total: 3000 }],
      [{ category: 'Varios', total: 1000 }],
    );
    expect(movers).toHaveLength(0);
  });

  it('marca categoría nueva con pct null', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Arrendamiento', total: 2000000 }],
      [],
    );
    expect(movers[0]).toMatchObject({ category: 'Arrendamiento', pct: null });
  });

  it('respeta minPct configurable', () => {
    const movers = computeCategoryMovers(
      [{ category: 'Gasoil', total: 560000 }],
      [{ category: 'Gasoil', total: 500000 }],
      { minPct: 20 },
    );
    expect(movers).toHaveLength(0);
  });

  it('devuelve como mucho `top` movers, ordenados por |pct| desc', () => {
    const movers = computeCategoryMovers(
      [
        { category: 'A', total: 200000 }, { category: 'B', total: 300000 },
        { category: 'C', total: 400000 }, { category: 'D', total: 500000 },
      ],
      [
        { category: 'A', total: 100000 }, { category: 'B', total: 200000 },
        { category: 'C', total: 300000 }, { category: 'D', total: 400000 },
      ],
      { top: 2 },
    );
    expect(movers).toHaveLength(2);
    expect(movers[0].category).toBe('A'); // +100% es el mayor |pct|
  });
});

describe('formatMoversLines', () => {
  it('devuelve string vacío sin movers', () => {
    expect(formatMoversLines([], fmt)).toBe('');
  });

  it('formatea suba, baja y nuevo', () => {
    const out = formatMoversLines([
      { category: 'Gasoil', pct: 18, now: 590000, before: 500000 },
      { category: 'Semillas', pct: -50, now: 400000, before: 800000 },
      { category: 'Arrendamiento', pct: null, now: 2000000, before: 0 },
    ], fmt);
    expect(out).toContain('Tendencias');
    expect(out).toContain('Gasoil: subió 18%');
    expect(out).toContain('Semillas: bajó 50%');
    expect(out).toContain('Arrendamiento: nuevo este mes');
  });
});
