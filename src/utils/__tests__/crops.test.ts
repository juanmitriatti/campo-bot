import { describe, it, expect } from 'vitest';
import { extractCropFromText } from '../crops.js';

describe('extractCropFromText', () => {
  it('matches a single canonical crop word', () => {
    expect(extractCropFromText('soja')).toBe('soja');
    expect(extractCropFromText('maíz')).toBe('maíz');
    expect(extractCropFromText('trigo')).toBe('trigo');
    expect(extractCropFromText('girasol')).toBe('girasol');
  });

  it('handles accents and case', () => {
    expect(extractCropFromText('MAÍZ')).toBe('maíz');
    expect(extractCropFromText('Maiz')).toBe('maíz');
    expect(extractCropFromText('algodon')).toBe('algodón');
  });

  it('handles Argentine variants', () => {
    expect(extractCropFromText('choclo')).toBe('maíz');
    expect(extractCropFromText('maicito')).toBe('maíz');
    expect(extractCropFromText('soya')).toBe('soja');
  });

  it('handles English anglicismos', () => {
    expect(extractCropFromText('soybean')).toBe('soja');
    expect(extractCropFromText('corn')).toBe('maíz');
    expect(extractCropFromText('wheat')).toBe('trigo');
    expect(extractCropFromText('sunflower')).toBe('girasol');
  });

  it('extracts crop from a sentence', () => {
    expect(extractCropFromText('es soja')).toBe('soja');
    expect(extractCropFromText('creo que maíz')).toBe('maíz');
    expect(extractCropFromText('sembré trigo, sí')).toBe('trigo');
  });

  it('returns null when no crop is mentioned', () => {
    expect(extractCropFromText('1B')).toBeNull();
    expect(extractCropFromText('don pedro')).toBeNull();
    expect(extractCropFromText('no se')).toBeNull();
    expect(extractCropFromText('')).toBeNull();
    expect(extractCropFromText('   ')).toBeNull();
  });

  it('returns null for ambiguous numeric/identifier replies', () => {
    expect(extractCropFromText('123')).toBeNull();
    expect(extractCropFromText('A1')).toBeNull();
  });

  it('does not match partial words by accident', () => {
    expect(extractCropFromText('manijero')).toBeNull();
    expect(extractCropFromText('socio')).toBeNull();
  });
});
