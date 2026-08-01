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

describe('validateToolCall — plot/field rule (Phase 3)', () => {
  const userPlots = ['1A', '1B', '1C', 'Norte', 'Sur'];
  const userFields = ['Don Pedro', 'La Esperanza'];
  const opts = { validatePlotField: true, userPlots, userFields };

  it('strips plot when not mentioned in user text (target bug)', () => {
    // "sembramos 3 hectareas" + agent infers plot="1B" from prefix → strip
    const input = { plot: '1B', hectares: 3 };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembramos 3 hectareas' },
      opts,
    );
    expect(result.input.plot).toBeUndefined();
    expect(result.droppedFields).toContain('plot');
  });

  it('preserves plot when user names it explicitly', () => {
    const input = { plot: '1B', crop: 'soja' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré soja en lote 1B' },
      opts,
    );
    expect(result.input.plot).toBe('1B');
  });

  it('preserves plot with accent/case variation in user text', () => {
    const input = { plot: 'Norte' };
    const result = validateToolCall(
      { toolName: 'log_spraying', input, originalText: 'fumigué el lote norte' },
      opts,
    );
    expect(result.input.plot).toBe('Norte');
  });

  it('preserves __last__ when user wrote a pronoun (ahí)', () => {
    const input = { plot: '__last__', product: 'glifosato' };
    const result = validateToolCall(
      { toolName: 'log_spraying', input, originalText: 'fumigué ahí con glifosato' },
      opts,
    );
    expect(result.input.plot).toBe('__last__');
  });

  it('preserves __last__ for "ese lote"', () => {
    const input = { plot: '__last__' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré soja en ese lote' },
      opts,
    );
    expect(result.input.plot).toBe('__last__');
  });

  it('strips __last__ when user did NOT use a pronoun', () => {
    const input = { plot: '__last__' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré 3 hectareas' },
      opts,
    );
    expect(result.input.plot).toBeUndefined();
    expect(result.droppedFields).toContain('plot');
  });

  it('strips plot when value is not a known plot of the user', () => {
    // Agent invented plot="Tommy" — not in user's plot list → strip
    const input = { plot: 'Tommy' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré en Tommy' },
      opts,
    );
    expect(result.input.plot).toBeUndefined();
  });

  it('strips field when user did not mention it', () => {
    const input = { field: 'Don Pedro', hectares: 5 };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré 5 ha' },
      opts,
    );
    expect(result.input.field).toBeUndefined();
  });

  it('preserves field with multi-word name when in text', () => {
    const input = { field: 'Don Pedro' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré soja en don pedro' },
      opts,
    );
    expect(result.input.field).toBe('Don Pedro');
  });

  it('does NOT validate plot for entity-creation tools (add_plot)', () => {
    // add_plot creates a NEW plot, so the plot name isn't in user's list yet
    const input = { plotName: 'tommy', field: 'Don Pedro' };
    const result = validateToolCall(
      { toolName: 'add_plot', input, originalText: 'agregar lote tommy en don pedro' },
      opts,
    );
    expect(result.input).toEqual(input); // untouched
  });

  it('does NOT validate plot for rename_plot', () => {
    const input = { oldName: '1A', newName: 'Sur', field: 'Don Pedro' };
    const result = validateToolCall(
      { toolName: 'rename_plot', input, originalText: 'renombrar lote 1A a Sur' },
      opts,
    );
    expect(result.input).toEqual(input);
  });

  it('does NOT strip plot when validatePlotField flag is off', () => {
    const input = { plot: '1B' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembramos 3 ha' },
      { validatePlotField: false, userPlots, userFields },
    );
    expect(result.input.plot).toBe('1B');
  });

  it('does NOT strip plot when userPlots list is empty (cannot validate safely)', () => {
    const input = { plot: '1B' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré 3 ha' },
      { validatePlotField: true, userPlots: [], userFields: [] },
    );
    expect(result.input.plot).toBe('1B');
  });

  it('word-boundary match: plot "1B" does not falsely match "1B12"', () => {
    const input = { plot: '1B' };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'algo 1B12 nada que ver' },
      opts,
    );
    expect(result.input.plot).toBeUndefined();
  });

  it('strips both plot and field when neither is in text', () => {
    const input = { plot: '1B', field: 'Don Pedro', hectares: 3 };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembré 3 hectareas' },
      opts,
    );
    expect(result.input.plot).toBeUndefined();
    expect(result.input.field).toBeUndefined();
    expect(result.input.hectares).toBe(3);
    expect(result.droppedFields).toEqual(expect.arrayContaining(['plot', 'field']));
  });

  it('crop and plot/field rules compose without interference', () => {
    const input = { crop: 'maíz', plot: '1B', hectares: 3 };
    const result = validateToolCall(
      { toolName: 'sow_crop', input, originalText: 'sembramos 3 hectareas' },
      { validateCrop: true, validatePlotField: true, userPlots, userFields },
    );
    expect(result.input.crop).toBeUndefined();
    expect(result.input.plot).toBeUndefined();
    expect(result.input.hectares).toBe(3);
    expect(result.droppedFields).toEqual(expect.arrayContaining(['crop', 'plot']));
  });

  it('cuantificador colectivo ("en cada lote"): lote REAL no literal en el texto se ACEPTA', () => {
    // "murieron 5 vacas en cada lote" → el agente distribuye nombrando cada
    // lote; strippearlos colapsaba las N tools en una por el dedup del compound.
    const result = validateToolCall(
      { toolName: 'record_livestock_death', input: { plot: '1B', count: 5 }, originalText: 'se murieron 5 vacas en cada lote' },
      opts,
    );
    expect(result.input.plot).toBe('1B');
    expect(result.droppedFields).toEqual([]);
  });

  it('cuantificador colectivo NO salva un lote INVENTADO (no está en userPlots)', () => {
    const result = validateToolCall(
      { toolName: 'record_livestock_death', input: { plot: 'Fantasma', count: 5 }, originalText: 'se murieron 5 vacas en cada lote' },
      opts,
    );
    expect(result.input.plot).toBeUndefined();
    expect(result.droppedFields).toContain('plot');
  });
});
