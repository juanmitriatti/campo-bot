import { describe, it, expect } from 'vitest';
import { userExplicitlyReferencedPlot } from './plot-intent.js';

describe('userExplicitlyReferencedPlot', () => {
  it('returns false for plain expense without plot mention', () => {
    expect(userExplicitlyReferencedPlot('pagué sueldos $300k')).toBe(false);
    expect(userExplicitlyReferencedPlot('cargué 50 mil en arrendamiento')).toBe(false);
    expect(userExplicitlyReferencedPlot('compré semillas')).toBe(false);
  });

  it('returns true for "en lote X"', () => {
    expect(userExplicitlyReferencedPlot('pagué sueldos en el lote Verde')).toBe(true);
    expect(userExplicitlyReferencedPlot('25 mil en lote Norte')).toBe(true);
    expect(userExplicitlyReferencedPlot('gasté en lote A1')).toBe(true);
  });

  it('returns true for pronoun "ahí mismo"', () => {
    expect(userExplicitlyReferencedPlot('y otros 25 mil en sueldos ahí mismo')).toBe(true);
    expect(userExplicitlyReferencedPlot('y otros 25 mil en sueldos ahi mismo')).toBe(true);
  });

  it('returns true for pronoun "ese lote"', () => {
    expect(userExplicitlyReferencedPlot('cargame 150 mil en fertilizante en ese lote')).toBe(true);
  });

  it('returns true for pronoun "el mismo"', () => {
    expect(userExplicitlyReferencedPlot('y 20 mil más en flete para el mismo')).toBe(true);
    expect(userExplicitlyReferencedPlot('15 mil en el mismo lote')).toBe(true);
  });

  it('returns true for "el de antes" / "el anterior"', () => {
    expect(userExplicitlyReferencedPlot('50 mil en herbicida en el de antes')).toBe(true);
    expect(userExplicitlyReferencedPlot('cargué 30 mil en el anterior')).toBe(true);
  });

  it('returns true for "potrero X" / "parcela X"', () => {
    expect(userExplicitlyReferencedPlot('20 mil en el potrero Sur')).toBe(true);
    expect(userExplicitlyReferencedPlot('compré para la parcela 3')).toBe(true);
  });

  it('returns false for unrelated mentions (no plot pronoun, no plot name)', () => {
    expect(userExplicitlyReferencedPlot('pagué sueldos')).toBe(false);
    expect(userExplicitlyReferencedPlot('ayer compré semillas')).toBe(false);
    expect(userExplicitlyReferencedPlot('cuánto llovió este mes')).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(userExplicitlyReferencedPlot(null)).toBe(false);
    expect(userExplicitlyReferencedPlot(undefined)).toBe(false);
    expect(userExplicitlyReferencedPlot('')).toBe(false);
  });

  it('returns true for "para el lote X"', () => {
    expect(userExplicitlyReferencedPlot('pagué sueldos para el lote Verde')).toBe(true);
  });
});
