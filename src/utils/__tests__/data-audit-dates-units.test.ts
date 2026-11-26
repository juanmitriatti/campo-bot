/**
 * Auditoría de datos (nov 2026): #17 cantidad de grano sin unidad y #20 fechas
 * que manda el agente.
 */
import { describe, it, expect } from 'vitest';
import { normalizeAgentDate, getTodayISO } from '../date.js';
import { inferGrainUnit } from '../mass-units.js';

describe('#20 normalizeAgentDate', () => {
  const year = getTodayISO().slice(0, 4);

  it('deja pasar ISO y recorta la hora', () => {
    expect(normalizeAgentDate('2026-11-05')).toBe('2026-11-05');
    expect(normalizeAgentDate('2026-11-05T10:00:00Z')).toBe('2026-11-05');
  });

  it('"05/11" es 5 de noviembre (no 11 de mayo)', () => {
    expect(normalizeAgentDate('05/11')).toBe(`${year}-11-05`);
    expect(normalizeAgentDate('5/11/26')).toBe('2026-11-05');
    expect(normalizeAgentDate('05-11-2026')).toBe('2026-11-05');
  });

  it('lo que no es una fecha o no existe da null', () => {
    for (const bad of ['ayer', '31/02/2026', '2026-13-01', '', '5', null, 20261105]) {
      expect(normalizeAgentDate(bad)).toBeNull();
    }
  });
});

describe('#17 unidad de una cantidad de grano sin unidad', () => {
  it('mil o más son kilos; menos, toneladas', () => {
    expect(inferGrainUnit(3000)).toBe('kg');
    expect(inferGrainUnit(130)).toBe('tn');
  });
});
