import { describe, it, expect } from 'vitest';
import { isLikelyQuestion } from '../guards.js';

describe('isLikelyQuestion', () => {
  it('detects "qué es eso?" as question', () => {
    expect(isLikelyQuestion('qué es eso?')).toBe(true);
  });

  it('detects "cuánto gasté este mes?" as question', () => {
    expect(isLikelyQuestion('cuánto gasté este mes?')).toBe(true);
  });

  it('detects "cómo está el clima?" as question', () => {
    expect(isLikelyQuestion('cómo está el clima?')).toBe(true);
  });

  it('detects "dónde está mi campo?" as question', () => {
    expect(isLikelyQuestion('dónde está mi campo?')).toBe(true);
  });

  it('detects "por qué no funciona?" as question', () => {
    expect(isLikelyQuestion('por qué no funciona?')).toBe(true);
  });

  it('detects "quién mandó eso?" as question', () => {
    expect(isLikelyQuestion('quién mandó eso?')).toBe(true);
  });

  it('does NOT match "gasté 5000 en gasoil"', () => {
    expect(isLikelyQuestion('gasté 5000 en gasoil')).toBe(false);
  });

  it('does NOT match "hola"', () => {
    expect(isLikelyQuestion('hola')).toBe(false);
  });

  it('does NOT match question word without trailing ?', () => {
    expect(isLikelyQuestion('cuánto gasté')).toBe(false);
  });

  it('does NOT match "vendí soja por 500mil"', () => {
    expect(isLikelyQuestion('vendí soja por 500mil')).toBe(false);
  });
});
