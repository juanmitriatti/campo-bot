import { describe, it, expect } from 'vitest';
import { validateToolCall } from '../agent-output-validator.js';

describe('validateToolCall (Phase 1 — passthrough)', () => {
  it('returns input unchanged', () => {
    const input = { crop: 'maíz', plot: '1B', hectares: 33 };
    const result = validateToolCall({
      toolName: 'sow_crop',
      input,
      originalText: 'sembramos 33 hectareas',
    });
    expect(result.input).toEqual(input);
    expect(result.droppedFields).toEqual([]);
  });

  it('preserves all fields including agent inferences (Phase 1 has no rules)', () => {
    // This test pins down the passthrough behavior. Once Phase 2 lands and
    // crop validation kicks in, we expect THIS test to need updating to
    // assert the inferred crop is dropped — that update is the signal that
    // Phase 2 actually shipped behavior change.
    const input = { crop: 'maíz', hectares: 3 };
    const result = validateToolCall({
      toolName: 'sow_crop',
      input,
      originalText: 'sembramos 3 hectareas',
    });
    expect(result.input.crop).toBe('maíz');
    expect(result.droppedFields).toEqual([]);
  });

  it('handles empty input', () => {
    const result = validateToolCall({
      toolName: 'sow_crop',
      input: {},
      originalText: 'sembramos',
    });
    expect(result.input).toEqual({});
    expect(result.droppedFields).toEqual([]);
  });

  it('handles unknown tool name (no-op)', () => {
    const input = { foo: 'bar' };
    const result = validateToolCall({
      toolName: 'made_up_tool',
      input,
      originalText: 'hola',
    });
    expect(result.input).toEqual(input);
  });
});
