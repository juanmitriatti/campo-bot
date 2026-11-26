/**
 * Cambiar de modelo desde /admin no puede romper las llamadas: Haiku 5.5 rechaza
 * `temperature` con 400 y puede devolver razonamiento antes del texto.
 */
import { describe, it, expect } from 'vitest';
import { acceptsSampling, requestParams, responseText } from '../model-params.js';
import { estimateCostUsd } from '../model-pricing.js';

describe('requestParams', () => {
  it('Haiku 4.5 se llama igual que antes', () => {
    expect(requestParams('claude-haiku-4-5-20251001', 1500, { temperature: 0, forcedTool: true }))
      .toEqual({ max_tokens: 1500, temperature: 0 });
    expect(requestParams('claude-haiku-4-5-20251001', 250, { temperature: 0 }))
      .toEqual({ max_tokens: 250, temperature: 0 });
  });

  it('Haiku 5.5 no recibe temperature y gana margen de tokens', () => {
    expect(requestParams('claude-haiku-5-5', 1500, { temperature: 0, forcedTool: true }))
      .toEqual({ max_tokens: 2025 });
    expect(requestParams('claude-haiku-5-5', 250, { temperature: 0 }))
      .toEqual({ max_tokens: 1024, output_config: { effort: 'low' } });
  });

  it('qué modelos aceptan temperature', () => {
    expect(acceptsSampling('claude-sonnet-4-6')).toBe(true);
    expect(acceptsSampling('claude-opus-4-6')).toBe(true);
    expect(acceptsSampling('claude-sonnet-5')).toBe(false);
    expect(acceptsSampling('claude-opus-4-7')).toBe(false);
    expect(requestParams('claude-sonnet-5', 3000, { temperature: 0 }).temperature).toBeUndefined();
  });

  it('el texto se lee por tipo de bloque, no por posición', () => {
    const content = [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'hola' }];
    expect(responseText({ content: content as never })).toBe('hola');
  });

  it('el costo de Haiku 5.5 usa su tarifa', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(estimateCostUsd('claude-haiku-5-5', usage)).toBeCloseTo(0.6);
    expect(estimateCostUsd('claude-haiku-4-5-20251001', usage)).toBeCloseTo(6);
  });
});
