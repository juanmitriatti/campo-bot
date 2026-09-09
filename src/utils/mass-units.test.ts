import { describe, it, expect } from 'vitest';
import { canonicalMassUnit, convertMass, normalizeToKg } from './mass-units.js';

describe('mass-units — fuente única de kg/tn/qq', () => {
  it('reconoce las abreviaturas comerciales', () => {
    expect(canonicalMassUnit('kg')).toBe('kg');
    expect(canonicalMassUnit('Kilos')).toBe('kg');
    expect(canonicalMassUnit('')).toBe('kg');
    expect(canonicalMassUnit('tn')).toBe('tn');
    expect(canonicalMassUnit('t')).toBe('tn');
    expect(canonicalMassUnit('toneladas')).toBe('tn');
    expect(canonicalMassUnit('qq')).toBe('qq');
    expect(canonicalMassUnit('quintales')).toBe('qq');
    expect(canonicalMassUnit('lt')).toBeNull();
    expect(canonicalMassUnit('bolsas')).toBeNull();
  });

  it('convierte entre unidades de masa y rechaza las que no lo son', () => {
    // P1-5: "cargar 130 tn de soja" sobre un ítem en kg.
    expect(convertMass(130, 'tn', 'kg')).toBe(130000);
    expect(convertMass(130000, 'kg', 'tn')).toBe(130);
    expect(convertMass(42, 'qq', 'kg')).toBe(4200);
    expect(convertMass(1, 'tn', 'qq')).toBe(10);
    expect(convertMass(10, 'lt', 'kg')).toBeNull();
    expect(convertMass(10, 'kg', 'bolsas')).toBeNull();
  });

  it('normalizeToKg conserva el comportamiento del mapper (t/ton = tonelada)', () => {
    expect(normalizeToKg(2, 't')).toBe(2000);
    expect(normalizeToKg(2, 'ton')).toBe(2000);
    expect(normalizeToKg(3, 'qq')).toBe(300);
    expect(normalizeToKg(5, 'kg')).toBe(5);
    expect(normalizeToKg(5, 'bolsas')).toBe(5); // desconocida → kg, con warning
    expect(normalizeToKg(null, 'kg')).toBeNull();
  });
});
