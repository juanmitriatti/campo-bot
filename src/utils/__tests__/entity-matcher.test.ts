import { describe, it, expect } from 'vitest';
import {
  normalizeEntityName,
  compactEntityName,
  stripLeadingArticle,
  entityNameCandidates,
  sqlNormalizedName,
} from '../entity-matcher.js';

describe('entity-matcher — normalización canónica', () => {
  // Tabla de la clase de bugs que motivó el módulo
  const EQUAL_PAIRS: Array<[string, string]> = [
    ['El Bajo', 'el bajo'],
    ['La Cañada', 'la canada'],
    ['El Trébol', 'el trebol'],
    ['Ñandú', 'nandu'],
    ['11 d', '11D'],
    ['11  D', '11d'],
    ['Lote  Norte', 'lote norte'],
    ['  Sur  ', 'sur'],
  ];

  it('compactEntityName: pares que DEBEN matchear', () => {
    for (const [a, b] of EQUAL_PAIRS) {
      expect(compactEntityName(a), `"${a}" vs "${b}"`).toBe(compactEntityName(b));
    }
  });

  it('normalizeEntityName conserva separación de palabras (para aliases)', () => {
    expect(normalizeEntityName('Lote  Norte')).toBe('lote norte');
    expect(normalizeEntityName('Ñandú')).toBe('nandu');
    expect(normalizeEntityName('El Trébol')).toBe('el trebol');
  });

  it('stripLeadingArticle pela solo el artículo de apertura', () => {
    expect(stripLeadingArticle('el norte')).toBe('norte');
    expect(stripLeadingArticle('La Loma')).toBe('Loma');
    expect(stripLeadingArticle('norte')).toBe('norte');
    expect(stripLeadingArticle('el')).toBe('el'); // nunca vacío
    expect(stripLeadingArticle('Losada')).toBe('Losada'); // "los" solo como palabra
  });

  it('entityNameCandidates: literal primero, artículo-pelado después', () => {
    expect(entityNameCandidates('El Bajo')).toEqual(['El Bajo', 'Bajo']);
    expect(entityNameCandidates('norte')).toEqual(['norte']);
  });

  it('nombres distintos NO colisionan', () => {
    expect(compactEntityName('Norte')).not.toBe(compactEntityName('Norte 2'));
    expect(compactEntityName('A1')).not.toBe(compactEntityName('A2'));
  });
});

// Paridad JS ↔ SQL: corre solo si hay DB disponible (local Docker o CI).
// La invariante crítica: compactEntityName(x) === resultado de sqlNormalizedName sobre x.
describe('entity-matcher — paridad JS/SQL', () => {
  it('sqlNormalizedName produce EXACTAMENTE compactEntityName para el set español', async () => {
    let pool;
    try {
      ({ pool } = await import('../../config/db.js'));
      await pool.query('SELECT 1');
    } catch {
      console.warn('[entity-matcher.test] DB no disponible — salteando paridad SQL');
      return;
    }
    const samples = ['El Bajo', 'La Cañada', 'El Trébol', 'Ñandú', '11 d', 'ÁÉÍÓÚÜÑ áéíóúüñ', 'Lote  Norte'];
    for (const s of samples) {
      const { rows } = await pool.query(`SELECT ${sqlNormalizedName('$1::text')} AS n`, [s]);
      expect(rows[0].n, `SQL vs JS para "${s}"`).toBe(compactEntityName(s));
    }
  });
});
