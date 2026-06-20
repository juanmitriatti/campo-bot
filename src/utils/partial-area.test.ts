import { describe, it, expect } from 'vitest';
import { resolvePartialArea, extractExplicitHectares, hasPartialAreaCue } from './partial-area.js';

describe('resolvePartialArea', () => {
  it('halves', () => {
    expect(resolvePartialArea('sembré la mitad del lote', 35)).toBe(17.5);
    expect(resolvePartialArea('en la mitad del lote', 40)).toBe(20);
    expect(resolvePartialArea('sembré medio lote', 50)).toBe(25);
  });

  it('thirds', () => {
    expect(resolvePartialArea('un tercio del lote', 30)).toBe(10);
    expect(resolvePartialArea('la tercera parte', 30)).toBe(10);
    expect(resolvePartialArea('dos tercios del lote', 30)).toBe(20);
  });

  it('quarters', () => {
    expect(resolvePartialArea('un cuarto del lote', 40)).toBe(10);
    expect(resolvePartialArea('la cuarta parte', 40)).toBe(10);
    expect(resolvePartialArea('tres cuartos del lote', 40)).toBe(30);
  });

  it('percentages', () => {
    expect(resolvePartialArea('el 30% del lote', 100)).toBe(30);
    expect(resolvePartialArea('sembré 25 por ciento', 80)).toBe(20);
    expect(resolvePartialArea('un 50 % del lote', 35)).toBe(17.5);
  });

  it('works without accents', () => {
    expect(resolvePartialArea('sembre la mitad', 35)).toBe(17.5);
  });

  it('returns null when no cue or no area', () => {
    expect(resolvePartialArea('sembré soja', 35)).toBeNull();
    expect(resolvePartialArea('la mitad del lote', null)).toBeNull();
    expect(resolvePartialArea('la mitad del lote', 0)).toBeNull();
    expect(resolvePartialArea('el 0% del lote', 35)).toBeNull();
  });
});

describe('hasPartialAreaCue', () => {
  it('detects fraction and percentage cues', () => {
    expect(hasPartialAreaCue('sembré la mitad del lote')).toBe(true);
    expect(hasPartialAreaCue('un tercio')).toBe(true);
    expect(hasPartialAreaCue('el 30% del lote')).toBe(true);
    expect(hasPartialAreaCue('tres cuartos')).toBe(true);
  });
  it('is false for plain text', () => {
    expect(hasPartialAreaCue('sembré soja en el norte')).toBe(false);
    expect(hasPartialAreaCue('no, era el lote sur')).toBe(false);
  });
});

describe('extractExplicitHectares', () => {
  it('parses explicit hectare amounts with various units', () => {
    expect(extractExplicitHectares('sembré solo 20 ha, no 35')).toBe(20);
    expect(extractExplicitHectares('eran 20 hs en lote loma')).toBe(20);
    expect(extractExplicitHectares('sembré 17,5 hectáreas')).toBe(17.5);
    expect(extractExplicitHectares('30 hectareas')).toBe(30);
  });

  it('grabs the corrected value, not the old one ("no 35")', () => {
    // first match is the new value
    expect(extractExplicitHectares('sembré solo 20 ha, no 35')).toBe(20);
  });

  it('returns null when there is no hectare unit', () => {
    expect(extractExplicitHectares('vendí 20 tn a 900 dólares')).toBeNull();
    expect(extractExplicitHectares('compré 50 bolsas')).toBeNull();
    expect(extractExplicitHectares('no, era el lote norte')).toBeNull();
  });
});
