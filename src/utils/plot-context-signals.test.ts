import { describe, it, expect } from 'vitest';
import { hasPlotContextSignal } from './plot-context-signals.js';

describe('hasPlotContextSignal', () => {
  describe('returns FALSE for fresh messages (no context signal)', () => {
    it('plain expense without plot mention', () => {
      expect(hasPlotContextSignal('Gaste 1 peso en girasoles')).toBe(false);
    });

    it('plain income statement', () => {
      expect(hasPlotContextSignal('cobré 50000 pesos')).toBe(false);
    });

    it('observation without lote keyword', () => {
      expect(hasPlotContextSignal('hay mucha maleza')).toBe(false);
    });

    it('expense with crop name only', () => {
      expect(hasPlotContextSignal('compré soja por 30 mil')).toBe(false);
    });

    it('long messages assume full context given', () => {
      const longMsg = 'a'.repeat(150);
      expect(hasPlotContextSignal(longMsg)).toBe(false);
    });
  });

  describe('returns TRUE for continuation starters', () => {
    it('starts with "y"', () => {
      expect(hasPlotContextSignal('y otros 50 mil en sueldos')).toBe(true);
    });

    it('starts with "y también"', () => {
      expect(hasPlotContextSignal('y también gasté 20 mil')).toBe(true);
    });

    it('starts with "además"', () => {
      expect(hasPlotContextSignal('además compré semillas')).toBe(true);
    });

    it('starts with "luego"', () => {
      expect(hasPlotContextSignal('luego pagué 30 mil')).toBe(true);
    });

    it('starts with "otros" (continuation)', () => {
      expect(hasPlotContextSignal('otros 15 mil en flete')).toBe(true);
    });

    it('starts with "más"', () => {
      expect(hasPlotContextSignal('más 10 mil en gasoil')).toBe(true);
    });
  });

  describe('returns TRUE for explicit plot mentions', () => {
    it('explicit "lote X"', () => {
      expect(hasPlotContextSignal('gasté 1 peso en lote Verde')).toBe(true);
    });

    it('explicit "potrero X"', () => {
      expect(hasPlotContextSignal('20mm en potrero 3')).toBe(true);
    });

    it('explicit "parcela X"', () => {
      expect(hasPlotContextSignal('observación parcela A')).toBe(true);
    });
  });

  describe('returns TRUE for plot pronouns (defensive — should be pre-expanded)', () => {
    it('"ahí mismo"', () => {
      expect(hasPlotContextSignal('y 20 mil ahí mismo')).toBe(true);
    });

    it('"ese lote"', () => {
      expect(hasPlotContextSignal('compré para ese lote')).toBe(true);
    });

    it('"el mismo"', () => {
      expect(hasPlotContextSignal('15 mil para el mismo')).toBe(true);
    });

    it('"el de antes"', () => {
      expect(hasPlotContextSignal('50 mil en el de antes')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('null/undefined input returns false', () => {
      expect(hasPlotContextSignal(null)).toBe(false);
      expect(hasPlotContextSignal(undefined)).toBe(false);
      expect(hasPlotContextSignal('')).toBe(false);
    });
  });
});
