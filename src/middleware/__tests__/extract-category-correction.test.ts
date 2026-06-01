import { describe, it, expect } from 'vitest';
import { extractCategoryCorrection } from '../conversation-engine.js';

describe('extractCategoryCorrection', () => {
  it('catches "no, es X"', () => {
    expect(extractCategoryCorrection('no, es gasoil')).toBe('gasoil');
  });

  it('catches "no, categoría X"', () => {
    expect(extractCategoryCorrection('no, categoría sueldos')).toBe('sueldos');
  });

  it('catches "cambiar a X"', () => {
    expect(extractCategoryCorrection('cambiar a fertilizante')).toBe('fertilizante');
  });

  it('catches "en realidad categoría X"', () => {
    expect(extractCategoryCorrection('en realidad categoría flete')).toBe('flete');
  });

  // NEW: "no, era en X" pattern (the CR02 fix)
  it('catches "no, era en sueldos" (CR02 fix)', () => {
    expect(extractCategoryCorrection('no, era en sueldos')).toBe('sueldos');
  });

  it('catches "no, era en gasoil"', () => {
    expect(extractCategoryCorrection('no, era en gasoil')).toBe('gasoil');
  });

  it('catches "no, fue en semillas"', () => {
    expect(extractCategoryCorrection('no, fue en semillas')).toBe('semillas');
  });

  it('does NOT catch "no, era en lote Verde" (plot, not category)', () => {
    // "lote Verde" is not in the category stoplist — falls through to plot
    // correction handled by correction-classifier upstream.
    expect(extractCategoryCorrection('no, era en lote Verde')).toBeNull();
  });

  it('does NOT catch "no, era en La Esperanza" (field name)', () => {
    expect(extractCategoryCorrection('no, era en La Esperanza')).toBeNull();
  });

  it('returns null for plain "no"', () => {
    expect(extractCategoryCorrection('no')).toBeNull();
    expect(extractCategoryCorrection('no, gracias')).toBeNull();
  });

  // NEW: trailing negation suffix must be stripped, else the old category leaks
  // and detectarCategoria re-matches it (prod bug: "no, era en sueldos no gasoil"
  // was saved as Combustible).
  it('strips "no <old>" suffix in "no, era en X no Y"', () => {
    expect(extractCategoryCorrection('no, era en sueldos no gasoil')).toBe('sueldos');
  });

  it('strips "no <old>" suffix in "no, es X no Y"', () => {
    expect(extractCategoryCorrection('no, es sueldos no gasoil')).toBe('sueldos');
  });

  it('returns null for empty input', () => {
    expect(extractCategoryCorrection('')).toBeNull();
    expect(extractCategoryCorrection('   ')).toBeNull();
  });
});
