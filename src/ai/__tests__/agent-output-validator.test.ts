import { describe, it, expect } from 'vitest';
import { validateToolCall } from '../agent-output-validator.js';

describe('validateToolCall — base behavior', () => {
  it('passthrough when no options set', () => {
    const input = { crop: 'maíz', plot: '1B', hectares: 33 };
    const result = validateToolCall({
      toolName: 'sow_crop',
      input,
      originalText: 'sembramos 33 hectareas',
    });
    expect(result.input).toEqual(input);
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

  it('does not mutate the original input object', () => {
    const input = { crop: 'maíz', hectares: 3 };
    validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembramos 3 ha' },
      { validateCrop: true },
    );
    expect(input.crop).toBe('maíz'); // original untouched
  });
});

describe('validateToolCall — crop rule (Phase 2)', () => {
  it('strips crop when user text mentions no crop', () => {
    // Target case: "sembramos 3 hectareas" with agent hallucinating crop=maíz
    const input = { crop: 'maíz', hectares: 3 };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembramos 3 hectareas' },
      { validateCrop: true },
    );
    expect(result.input.crop).toBeUndefined();
    expect(result.input.hectares).toBe(3);
    expect(result.droppedFields).toContain('crop');
  });

  it('preserves crop when user text mentions it', () => {
    const input = { crop: 'soja', hectares: 20 };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré soja en 20 has' },
      { validateCrop: true },
    );
    expect(result.input.crop).toBe('soja');
    expect(result.droppedFields).toEqual([]);
  });

  it('preserves crop when user uses an English anglicismo (soybean → soja)', () => {
    const input = { crop: 'soja' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembramos soybean en lote 1A' },
      { validateCrop: true },
    );
    expect(result.input.crop).toBe('soja');
  });

  it('preserves crop when user uses a Spanish synonym (choclo → maíz)', () => {
    const input = { crop: 'maíz' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembramos choclo' },
      { validateCrop: true },
    );
    expect(result.input.crop).toBe('maíz');
  });

  it('handles accent and case differences', () => {
    const input = { crop: 'Maíz' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembramos MAIZ' },
      { validateCrop: true },
    );
    expect(result.input.crop).toBe('Maíz');
  });

  it('strips crop when agent crop and user crop diverge (target bug)', () => {
    // Real failure mode: user says "sembré soja" but agent infers crop=maíz
    // from active_crop on the plot. Validator must catch the mismatch.
    const input = { crop: 'maíz' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré soja' },
      { validateCrop: true },
    );
    expect(result.input.crop).toBeUndefined();
    expect(result.droppedFields).toContain('crop');
  });

  it('does not strip when validateCrop flag is off (gradual rollout)', () => {
    const input = { crop: 'maíz', hectares: 3 };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembramos 3 hectareas' },
      { validateCrop: false },
    );
    expect(result.input.crop).toBe('maíz');
  });

  it('only validates crop on crop-aware tools (does not touch unrelated tools)', () => {
    // log_expense doesn't carry a `crop` param in our schema, but if some
    // future tool input has a string field happening to be named `crop`,
    // the rule shouldn't apply.
    const input = { crop: 'maíz', amount: 100 };
    const result = validateToolCall(
      { toolName: 'log_expense', input, originalText: 'gasté 100' },
      { validateCrop: true },
    );
    expect(result.input.crop).toBe('maíz');
  });

  it('preserves the __last__ pronoun sentinel even when validateCrop is on', () => {
    // crop="__last__" doesn't exist in our flows today, but the rule must
    // be defensive against any pronoun sentinel reaching the validator.
    const input = { crop: '__last__' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré ahí' },
      { validateCrop: true },
    );
    expect(result.input.crop).toBe('__last__');
  });
});
