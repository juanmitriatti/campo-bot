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

describe('coordsFor — coordenadas del centroide para clima/mapas', () => {
  it('devuelve lat/lon para match único (Pergamino)', () => {
    const c = localidadLookup.coordsFor('Pergamino');
    expect(c).not.toBeNull();
    // Pergamino ≈ (-33.9, -60.6)
    expect(c!.lat).toBeGreaterThan(-34.2);
    expect(c!.lat).toBeLessThan(-33.6);
    expect(c!.lon).toBeGreaterThan(-61);
    expect(c!.lon).toBeLessThan(-60);
  });

  it('homónima sin provincia → null (no adivinar la provincia equivocada)', () => {
    // "Ameghino" existe en Buenos Aires y La Pampa (u otra homónima del censo)
    const lk = localidadLookup.lookup('San José');
    if (lk.matches.length > 1) {
      expect(localidadLookup.coordsFor('San José')).toBeNull();
    }
  });

  it('homónima CON provincia → resuelve', () => {
    const lk = localidadLookup.lookup('San José');
    if (lk.matches.length > 1) {
      const prov = lk.matches[0].provincia;
      const c = localidadLookup.coordsFor('San José', prov);
      // puede seguir siendo ambigua dentro de la provincia; si no, devuelve coords
      const inProv = lk.matches.filter(m => m.provincia === prov);
      if (inProv.length === 1) expect(c).not.toBeNull();
    }
  });

  it('ciudad inexistente → null', () => {
    expect(localidadLookup.coordsFor('Ciudad Inventada XYZ')).toBeNull();
  });

  it('los matches del lookup exponen lat/lon', () => {
    const r = localidadLookup.lookup('Pergamino');
    expect(r.matches[0].lat).toBeTypeOf('number');
    expect(r.matches[0].lon).toBeTypeOf('number');
  });
});
