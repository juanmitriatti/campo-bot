import { describe, it, expect } from 'vitest';
import { localidadLookup } from '../localidad-lookup.service.js';

describe('LocalidadLookupService', () => {
  it('exact single match — Pergamino', () => {
    const result = localidadLookup.lookup('Pergamino');
    expect(result.status).toBe('exact');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].nombre).toBe('Pergamino');
    expect(result.matches[0].provincia).toBe('Buenos Aires');
  });

  it('accent handling — El Trébol = el trebol', () => {
    const result = localidadLookup.lookup('el trebol');
    expect(result.status).toBe('exact');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].nombre).toBe('El Trébol');
    expect(result.matches[0].provincia).toBe('Santa Fe');
  });

  it('disambiguation — San José → multiple provinces', () => {
    const result = localidadLookup.lookup('San José');
    expect(['disambiguate', 'exact']).toContain(result.status);
    if (result.status === 'disambiguate') {
      expect(result.matches.length).toBeGreaterThan(1);
      const provinces = new Set(result.matches.map(m => m.provincia));
      expect(provinces.size).toBeGreaterThan(1);
    }
  });

  it('disambiguation with province — San José, Entre Ríos → exact', () => {
    const result = localidadLookup.lookup('San José, Entre Ríos');
    expect(result.status).toBe('exact');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].provincia).toBe('Entre Ríos');
  });

  it('fuzzy suggestions — Pergamno → Pergamino', () => {
    const result = localidadLookup.lookup('Pergamno');
    expect(result.status).toBe('suggestions');
    expect(result.matches.some(m => m.nombre === 'Pergamino')).toBe(true);
  });

  it('not found — NonexistentCity123', () => {
    const result = localidadLookup.lookup('NonexistentCity123');
    expect(result.status).toBe('not_found');
    expect(result.matches).toHaveLength(0);
  });

  it('empty input', () => {
    const result = localidadLookup.lookup('');
    expect(result.status).toBe('not_found');
  });

  it('startsWith match — Perga', () => {
    const result = localidadLookup.lookup('Perga');
    expect(result.status).toBe('suggestions');
    expect(result.matches.some(m => m.nombre === 'Pergamino')).toBe(true);
  });

  it('case insensitive — pergamino', () => {
    const result = localidadLookup.lookup('pergamino');
    expect(result.status).toBe('exact');
    expect(result.matches[0].nombre).toBe('Pergamino');
  });

  it('Lincoln exact match', () => {
    const result = localidadLookup.lookup('Lincoln');
    expect(result.status).toBe('exact');
    expect(result.matches[0].nombre).toBe('Lincoln');
  });

  it('Rosario exact match', () => {
    const result = localidadLookup.lookup('Rosario');
    expect(result.status).toBe('exact');
    expect(result.matches[0].nombre).toBe('Rosario');
    expect(result.matches[0].provincia).toBe('Santa Fe');
  });
});
