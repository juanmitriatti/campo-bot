import { describe, it, expect } from 'vitest';
import { isLikelyQuestion, isPlaceholder } from '../guards.js';

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

describe('isPlaceholder', () => {
  it('detects null/undefined as placeholder', () => {
    expect(isPlaceholder(null)).toBe(true);
    expect(isPlaceholder(undefined)).toBe(true);
  });

  it('detects empty/whitespace string as placeholder', () => {
    expect(isPlaceholder('')).toBe(true);
    expect(isPlaceholder('   ')).toBe(true);
  });

  it('detects angle-bracket placeholders like <UNKNOWN>', () => {
    expect(isPlaceholder('<UNKNOWN>')).toBe(true);
    expect(isPlaceholder('<unknown>')).toBe(true);
    expect(isPlaceholder('<missing>')).toBe(true);
    expect(isPlaceholder('<crop>')).toBe(true);
  });

  it('detects common Spanish/English placeholder words', () => {
    expect(isPlaceholder('unknown')).toBe(true);
    expect(isPlaceholder('Desconocido')).toBe(true);
    expect(isPlaceholder('sin especificar')).toBe(true);
    expect(isPlaceholder('N/A')).toBe(true);
    expect(isPlaceholder('null')).toBe(true);
    expect(isPlaceholder('undefined')).toBe(true);
  });

  it('detects generic field-name echoes as placeholders', () => {
    expect(isPlaceholder('cultivo')).toBe(true);
    expect(isPlaceholder('producto')).toBe(true);
    expect(isPlaceholder('categoria')).toBe(true);
    expect(isPlaceholder('categoría')).toBe(true);
  });

  it('detects single-char garbage like "?" or "-"', () => {
    expect(isPlaceholder('?')).toBe(true);
    expect(isPlaceholder('???')).toBe(true);
    expect(isPlaceholder('-')).toBe(true);
    expect(isPlaceholder('---')).toBe(true);
  });

  it('does NOT flag real crop names', () => {
    expect(isPlaceholder('soja')).toBe(false);
    expect(isPlaceholder('maíz')).toBe(false);
    expect(isPlaceholder('trigo')).toBe(false);
    expect(isPlaceholder('girasol')).toBe(false);
  });

  it('does NOT flag real product names', () => {
    expect(isPlaceholder('glifosato')).toBe(false);
    expect(isPlaceholder('urea')).toBe(false);
    expect(isPlaceholder('Roundup')).toBe(false);
  });

  it('does NOT flag non-string values that arent null/undefined', () => {
    expect(isPlaceholder(42)).toBe(false);
    expect(isPlaceholder(false)).toBe(false);
    expect(isPlaceholder({})).toBe(false);
  });
});
