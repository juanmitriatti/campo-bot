import { describe, it, expect } from 'vitest';
import { resolveSelfCorrection } from '../self-correction.js';

describe('resolveSelfCorrection — crop', () => {
  it('the reported bug: soja → maíz embedded', () => {
    expect(resolveSelfCorrection('sembré soja en el lote Norte no era maíz, 100 has'))
      .toBe('sembré maíz en el lote Norte, 100 has');
  });
  it('typos / no accents (sembre, maiz)', () => {
    expect(resolveSelfCorrection('sembre soja en el lote Norte no era maiz, 100 has'))
      .toBe('sembre maíz en el lote Norte, 100 has');
  });
  it('explicit cue without copula: "en realidad"', () => {
    expect(resolveSelfCorrection('coseché trigo en A1, en realidad cebada'))
      .toBe('coseché cebada en A1');
  });
  it('cue "quise decir"', () => {
    expect(resolveSelfCorrection('sembré girasol, quise decir sorgo'))
      .toBe('sembré sorgo');
  });
  it('cue "perdón, era"', () => {
    expect(resolveSelfCorrection('fumigué soja perdón era maíz'))
      .toBe('fumigué maíz');
  });
});

describe('resolveSelfCorrection — number with unit', () => {
  it('hectares correction', () => {
    expect(resolveSelfCorrection('sembré 50 has no eran 80 has'))
      .toBe('sembré 80 has');
  });
  it('litros correction with "en realidad"', () => {
    expect(resolveSelfCorrection('apliqué 100 lt, en realidad 120 lt'))
      .toBe('apliqué 120 lt');
  });
});

describe('resolveSelfCorrection — conservative (must NOT fire)', () => {
  it('contrast without copula ("soja, no maíz")', () => {
    const t = 'sembré soja, no maíz';
    expect(resolveSelfCorrection(t)).toBe(t);
  });
  it('no typed value after the cue', () => {
    const t = 'sembré soja en el lote norte no era barato';
    expect(resolveSelfCorrection(t)).toBe(t);
  });
  it('money is left to the money handler (no unit → no number rewrite)', () => {
    const t = 'gasté 50 mil no eran 80 mil';
    expect(resolveSelfCorrection(t)).toBe(t);
  });
  it('crop without a sow/harvest/spray verb does not fire', () => {
    const t = 'el precio no era soja';
    expect(resolveSelfCorrection(t)).toBe(t);
  });
  it('same value → no rewrite', () => {
    const t = 'sembré maíz no era maíz';
    expect(resolveSelfCorrection(t)).toBe(t);
  });
  it('normal message unchanged', () => {
    const t = 'sembré soja en el lote Norte, 100 has';
    expect(resolveSelfCorrection(t)).toBe(t);
  });
  it('empty / passthrough', () => {
    expect(resolveSelfCorrection('')).toBe('');
    expect(resolveSelfCorrection('hola, cómo estás')).toBe('hola, cómo estás');
  });
});
