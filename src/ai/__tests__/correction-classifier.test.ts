import { describe, it, expect } from 'vitest';
import { detectCorrection } from '../correction-classifier.js';

describe('detectCorrection — plot corrections (high precision)', () => {
  it('catches "no, era en lote 1C"', () => {
    const r = detectCorrection('no, era en lote 1C');
    expect(r?.newPlot).toBe('1C');
  });

  it('catches "no, fue en el lote norte"', () => {
    const r = detectCorrection('no, fue en el lote norte');
    expect(r?.newPlot?.toLowerCase()).toBe('norte');
  });

  it('catches "no, las sembramos en el lote 1C" (the user-reported bug)', () => {
    const r = detectCorrection('no, las sembramos en el lote 1C');
    expect(r?.newPlot).toBe('1C');
  });

  it('catches "no, lo cosechamos en el lote norte"', () => {
    const r = detectCorrection('no, lo cosechamos en el lote norte');
    expect(r?.newPlot?.toLowerCase()).toBe('norte');
  });

  it('catches "perdón, era en el campo Don Pedro"', () => {
    const r = detectCorrection('perdón, era en el campo Don Pedro');
    expect(r?.newPlot).toBe('Don Pedro');
  });

  it('catches "me equivoqué, era en lote 4"', () => {
    const r = detectCorrection('me equivoqué, era en lote 4');
    expect(r?.newPlot).toBe('4');
  });

  it('handles missing comma', () => {
    const r = detectCorrection('no era en lote 1C');
    expect(r?.newPlot).toBe('1C');
  });

  it('handles trailing punctuation', () => {
    const r = detectCorrection('no, era en lote 1C.');
    expect(r?.newPlot).toBe('1C');
  });
});

describe('detectCorrection — crop corrections', () => {
  it('catches "no, era soja"', () => {
    const r = detectCorrection('no, era soja');
    expect(r?.newCrop).toBe('soja');
  });

  it('catches "perdón, era maíz"', () => {
    const r = detectCorrection('perdón, era maíz');
    expect(r?.newCrop).toBe('maíz');
  });

  it('catches "no, fue trigo"', () => {
    const r = detectCorrection('no, fue trigo');
    expect(r?.newCrop).toBe('trigo');
  });

  it('handles English anglicismo "no, era soybean"', () => {
    const r = detectCorrection('no, era soybean');
    expect(r?.newCrop).toBe('soja');
  });
});

describe('detectCorrection — does NOT trigger on non-corrections', () => {
  it('returns null for "no llovió"', () => {
    expect(detectCorrection('no llovió')).toBeNull();
  });

  it('returns null for "no llovieron 30mm"', () => {
    expect(detectCorrection('no llovieron 30mm')).toBeNull();
  });

  it('returns null for plain registration "sembré soja en lote norte"', () => {
    expect(detectCorrection('sembré soja en lote norte')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detectCorrection('')).toBeNull();
  });

  it('returns null for whitespace', () => {
    expect(detectCorrection('   ')).toBeNull();
  });

  it('returns null for "no" alone', () => {
    expect(detectCorrection('no')).toBeNull();
  });

  it('returns null for "no, gracias"', () => {
    expect(detectCorrection('no, gracias')).toBeNull();
  });

  it('returns null for "no quiero"', () => {
    expect(detectCorrection('no quiero')).toBeNull();
  });

  it('returns null when correction prefix is missing ("era en lote norte")', () => {
    // "era en X" alone is not a correction — needs the explicit signal
    expect(detectCorrection('era en lote norte')).toBeNull();
  });

  it('returns null when crop is unknown', () => {
    expect(detectCorrection('no, era manzana')).toBeNull();
  });

  it('returns null for "no, era ahí" (lone pronoun is not a plot reference)', () => {
    expect(detectCorrection('no, era ahí')).toBeNull();
  });

  it('returns null for "no, era en sueldos" (category, not plot)', () => {
    // Without the category stoplist, the regex matches "sueldos" as plot — wrong!
    expect(detectCorrection('no, era en sueldos')).toBeNull();
  });

  it('returns null for "no, era en gasoil" (category)', () => {
    expect(detectCorrection('no, era en gasoil')).toBeNull();
  });

  it('returns null for "no, era en semillas" (category)', () => {
    expect(detectCorrection('no, era en semillas')).toBeNull();
  });

  it('returns null for "no, era en fertilizante" (category)', () => {
    expect(detectCorrection('no, era en fertilizante')).toBeNull();
  });

  it('returns null for "no, era en herbicida" (category)', () => {
    expect(detectCorrection('no, era en herbicida')).toBeNull();
  });

  it('still catches plot correction with category-looking word inside name', () => {
    // e.g., user names their plot "Sueldos" — they need the explicit keyword
    const r = detectCorrection('no, era en lote sueldos');
    // With keyword present, the regex captures only what's AFTER "lote"
    expect(r?.newPlot?.toLowerCase()).toBe('sueldos');
  });
});

describe('detectCorrection — case insensitivity', () => {
  it('handles uppercase prefix', () => {
    const r = detectCorrection('NO, era en lote 1C');
    expect(r?.newPlot).toBe('1C');
  });

  it('handles mixed case', () => {
    const r = detectCorrection('No, Era En Lote Norte');
    expect(r?.newPlot?.toLowerCase()).toBe('norte');
  });
});
