import { describe, it, expect } from 'vitest';
import { extractRenameCorrection } from '../conversation-engine.js';

describe('extractRenameCorrection', () => {
  it('parses "se llama X, no Y"', () => {
    expect(extractRenameCorrection('Se llama Don Carletti, no Carleti'))
      .toBe('Don Carletti');
  });
  it('parses "se llama X"', () => {
    expect(extractRenameCorrection('Se llama Don Pedro')).toBe('Don Pedro');
  });
  it('parses "no X, es Y"', () => {
    expect(extractRenameCorrection('No Carleti, es Don Carletti')).toBe('Don Carletti');
  });
  it('parses "es X, no Y"', () => {
    expect(extractRenameCorrection('Es Don Carletti, no Carleti')).toBe('Don Carletti');
  });
  it('parses "el nombre es X"', () => {
    expect(extractRenameCorrection('El nombre es Las Tres Marías')).toBe('Las Tres Marías');
  });
  it('returns null for unrelated text', () => {
    expect(extractRenameCorrection('Pergamino')).toBeNull();
    expect(extractRenameCorrection('Sembré soja en 1A')).toBeNull();
    expect(extractRenameCorrection('cancelar')).toBeNull();
  });
});
