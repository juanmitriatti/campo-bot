import { describe, it, expect } from 'vitest';
import { userExplicitlyReferencedPlot, isPlotAnswerToFlow } from '../plot-intent.js';

describe('userExplicitlyReferencedPlot', () => {
  it('detects explicit "lote X" references (the plot-reply case)', () => {
    expect(userExplicitlyReferencedPlot('lote a')).toBe(true);
    expect(userExplicitlyReferencedPlot('el lote 3')).toBe(true);
    expect(userExplicitlyReferencedPlot('en lote norte')).toBe(true);
    expect(userExplicitlyReferencedPlot('potrero sur')).toBe(true);
  });

  it('detects plot pronouns', () => {
    expect(userExplicitlyReferencedPlot('ahí mismo')).toBe(true);
    expect(userExplicitlyReferencedPlot('ese lote')).toBe(true);
    expect(userExplicitlyReferencedPlot('el de antes')).toBe(true);
  });

  it('returns false for non-plot text', () => {
    expect(userExplicitlyReferencedPlot('pagué 50 mil de sueldos')).toBe(false);
    expect(userExplicitlyReferencedPlot('cuánto gasté este mes')).toBe(false);
    expect(userExplicitlyReferencedPlot('')).toBe(false);
  });
});

describe('isPlotAnswerToFlow — protects plot-collecting flows from being cancelled', () => {
  it('treats a plot reply as the answer inside a plot-collecting flow', () => {
    // Regression: "gasté 120 mil en X" → "¿en qué lote?" → "lote a" must NOT
    // cancel the flow + drop the expense.
    expect(isPlotAnswerToFlow('expense_flow', 'lote a')).toBe(true);
    expect(isPlotAnswerToFlow('income_flow', 'en lote norte')).toBe(true);
    expect(isPlotAnswerToFlow('activity_flow', 'ahí mismo')).toBe(true);
    expect(isPlotAnswerToFlow('rainfall_flow', 'el lote 3')).toBe(true);
  });

  it('does NOT suppress when the flow is not plot-collecting', () => {
    expect(isPlotAnswerToFlow('field_flow', 'lote a')).toBe(false);
    expect(isPlotAnswerToFlow('idle', 'lote a')).toBe(false);
    expect(isPlotAnswerToFlow(null, 'lote a')).toBe(false);
  });

  it('does NOT suppress a non-plot reply (real command interruption still works)', () => {
    expect(isPlotAnswerToFlow('expense_flow', 'cuánto gasté este mes')).toBe(false);
    expect(isPlotAnswerToFlow('expense_flow', 'cancelar')).toBe(false);
  });
});
