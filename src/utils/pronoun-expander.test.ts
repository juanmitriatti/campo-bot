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

  it('swaps "ese mismo lote"', () => {
    const { expanded } = expandPronouns('fumigué ese mismo lote', 'A1');
    expect(expanded).toBe('fumigué en lote A1');
  });

  describe('ahí también / igual + ahí + verbo (reportado live por audio)', () => {
    it('"ahi tambien fumigue" → en lote X (Whisper transcribe "ahí también")', () => {
      const { expanded } = expandPronouns('ahi tambien fumigue con glifosato 3 litros por hectarea', 'Norte');
      expect(expanded).toBe('en lote Norte fumigue con glifosato 3 litros por hectarea');
    });
    it('"ahí también fumigué" (con acentos)', () => {
      const { expanded } = expandPronouns('ahí también fumigué con glifosato', 'Norte');
      expect(expanded).toBe('en lote Norte fumigué con glifosato');
    });
    it('"ahi igual sembre" → en lote X', () => {
      const { expanded } = expandPronouns('ahi igual sembre maiz', 'Sur');
      expect(expanded).toBe('en lote Sur sembre maiz');
    });
    it('"ahi sembre soja" (ahí + verbo, sin adverbio) → en lote X', () => {
      const { expanded } = expandPronouns('ahi sembre soja', 'Norte');
      expect(expanded).toBe('en lote Norte sembre soja');
    });
    it('"ahí coseché trigo" → en lote X', () => {
      const { expanded } = expandPronouns('ahí coseché trigo', 'Norte');
      expect(expanded).toBe('en lote Norte coseché trigo');
    });
    it('"ahí" sin verbo agro NO se expande (evita falsos positivos)', () => {
      const { expanded, replaced } = expandPronouns('quedó ahí guardado', 'Norte');
      expect(replaced).toBe(0);
      expect(expanded).toBe('quedó ahí guardado');
    });
  });

  describe('el otro lote (prevPlotName)', () => {
    it('swaps "el otro lote" to the previous plot', () => {
      const { expanded, replaced } = expandPronouns('y 30k de semillas en el otro lote', 'Norte', 'Sur');
      expect(expanded).toBe('y 30k de semillas en lote Sur');
      expect(replaced).toBe(1);
    });

    it('"el otro" tras preposición sin sustantivo', () => {
      const { expanded } = expandPronouns('sembré maíz en el otro', 'Norte', 'Sur');
      expect(expanded).toBe('sembré maíz en lote Sur');
    });

    it('"el otro día" (temporal) NO se expande', () => {
      const { expanded, replaced } = expandPronouns('el otro día fumigué', 'Norte', 'Sur');
      expect(expanded).toBe('el otro día fumigué');
      expect(replaced).toBe(0);
    });

    it('"el otro lote" sin prevPlotName pasa sin tocar', () => {
      const { expanded, replaced } = expandPronouns('gasté 20k en el otro lote', 'Norte');
      expect(expanded).toBe('gasté 20k en el otro lote');
      expect(replaced).toBe(0);
    });

    it('mezcla: "ahí mismo" → último, "el otro lote" → anterior', () => {
      const { expanded } = expandPronouns('20mm ahí mismo y 35mm en el otro lote', 'Norte', 'Sur');
      expect(expanded).toBe('20mm en lote Norte y 35mm en lote Sur');
    });
  });
});
