import { describe, it, expect } from 'vitest';
import { stripPlotCorrectionPrefix } from '../flows/field-step-helpers.js';

describe('stripPlotCorrectionPrefix', () => {
  it('strips "perdón, fue en X"', () => {
    expect(stripPlotCorrectionPrefix('Perdón, fue en B1')).toBe('B1');
    expect(stripPlotCorrectionPrefix('perdon fue en lote B1')).toBe('B1');
  });
  it('strips "no, en X"', () => {
    expect(stripPlotCorrectionPrefix('no, en B1')).toBe('B1');
    expect(stripPlotCorrectionPrefix('No es B1')).toBe('B1');
  });
  it('strips "en realidad ..."', () => {
    expect(stripPlotCorrectionPrefix('En realidad fue en B2')).toBe('B2');
    expect(stripPlotCorrectionPrefix('en realidad, en B2')).toBe('B2');
  });
  it('strips "sí, en X"', () => {
    expect(stripPlotCorrectionPrefix('Sí, en B1')).toBe('B1');
  });
  it('strips "disculpá, en X"', () => {
    expect(stripPlotCorrectionPrefix('Disculpá, en B1')).toBe('B1');
  });
  it('strips field-qualified corrections', () => {
    expect(stripPlotCorrectionPrefix('Perdón, en el lote B1 La Esperanza')).toBe('B1 La Esperanza');
  });
  it('returns null when no correction prefix matches', () => {
    expect(stripPlotCorrectionPrefix('B1')).toBeNull();
    expect(stripPlotCorrectionPrefix('A1 La Esperanza')).toBeNull();
    expect(stripPlotCorrectionPrefix('cancelar')).toBeNull();
  });
});
