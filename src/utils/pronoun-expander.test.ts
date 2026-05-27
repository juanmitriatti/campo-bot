import { describe, it, expect } from 'vitest';
import { expandPronouns } from './pronoun-expander.js';

describe('expandPronouns', () => {
  it('swaps "ahi mismo" for "en lote <name>"', () => {
    const { expanded, replaced } = expandPronouns('y otros 50000 en sueldos ahi mismo', 'Norte');
    expect(expanded).toBe('y otros 50000 en sueldos en lote Norte');
    expect(replaced).toBe(1);
  });

  it('swaps "ahí mismo" (with accent)', () => {
    const { expanded, replaced } = expandPronouns('llovieron 20mm ahí mismo', 'Sur');
    expect(expanded).toBe('llovieron 20mm en lote Sur');
    expect(replaced).toBe(1);
  });

  it('collapses "en ahí" → "en lote <name>" (avoids double prep)', () => {
    const { expanded } = expandPronouns('gasté 30k en gasoil en ahí', 'Norte');
    expect(expanded).toBe('gasté 30k en gasoil en lote Norte');
  });

  it('swaps "el mismo lote" → "en lote <name>"', () => {
    const { expanded } = expandPronouns('compré semillas en el mismo lote', 'Sur');
    expect(expanded).toBe('compré semillas en lote Sur');
  });

  it('swaps "ese lote"', () => {
    const { expanded } = expandPronouns('otros 10k en ese lote', 'A1');
    expect(expanded).toBe('otros 10k en lote A1');
  });

  it('swaps "ahí" alone after a preposition', () => {
    const { expanded } = expandPronouns('llovieron 20mm ahí', 'Norte');
    expect(expanded).toBe('llovieron 20mm ahí'); // bare "ahí" without prep stays
  });

  it('swaps "del anterior" / "el de antes"', () => {
    const { expanded } = expandPronouns('sembré soja en el de antes', 'B2');
    expect(expanded).toBe('sembré soja en lote B2');
  });

  it('returns text unchanged when no pronoun', () => {
    const { expanded, replaced } = expandPronouns('agregar campo X en Pergamino', 'Norte');
    expect(expanded).toBe('agregar campo X en Pergamino');
    expect(replaced).toBe(0);
  });

  it('returns text unchanged when no lastPlotName', () => {
    const { expanded, replaced } = expandPronouns('y 50k en sueldos ahi mismo', null);
    expect(expanded).toBe('y 50k en sueldos ahi mismo');
    expect(replaced).toBe(0);
  });

  it('handles plot names with spaces', () => {
    const { expanded } = expandPronouns('vendí 20tn ahi mismo', 'Lote Norte Grande');
    expect(expanded).toBe('vendí 20tn en lote Lote Norte Grande');
  });
});
