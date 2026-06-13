import { describe, it, expect } from 'vitest';
import { formatDateAR, formatDateShortAR } from './date.js';

describe('formatDateAR — DATE columns (off-by-one guard)', () => {
  // node-postgres devuelve las columnas DATE como Date a medianoche UTC.
  // Formatear eso en ART (UTC-3) lo corría al día anterior — bug live Jun 2026
  // (vacunación del 12/06 se mostraba "11/06").
  it('una columna DATE a medianoche UTC rinde el MISMO día calendario', () => {
    const midnightUTC = new Date('2026-06-12T00:00:00.000Z');
    expect(formatDateAR(midnightUTC)).toBe('12/06/2026');
  });

  it('string YYYY-MM-DD rinde el mismo día (sin desfase)', () => {
    expect(formatDateAR('2026-06-12')).toBe('12/06/2026');
    expect(formatDateAR('2026-01-01')).toBe('01/01/2026');
  });

  it('un timestamp real con hora del día NO se altera', () => {
    expect(formatDateAR(new Date('2026-06-12T18:30:00.000Z'))).toBe('12/06/2026');
    // 02:00 UTC = 23:00 ART del día anterior → comportamiento correcto de instante
    expect(formatDateAR(new Date('2026-06-12T02:00:00.000Z'))).toBe('11/06/2026');
  });

  it('formatDateShortAR también corrige el desfase (día 12, no 11)', () => {
    expect(formatDateShortAR(new Date('2026-06-12T00:00:00.000Z'))).toMatch(/^12\/0?6$/);
  });
});
