import { describe, it, expect } from 'vitest';
import { validateToolCall } from './agent-output-validator.js';

const OPTS = {
  validateCrop: true,
  validatePlotField: true,
  userPlots: ['Norte', 'Sur', 'Lote Norte Grande', '1B', '1B12'],
  userFields: ['La Esperanza', 'San Martin'],
};

describe('agent-output-validator — crop', () => {
  it('mantiene el crop cuando está en el texto', () => {
    const r = validateToolCall(
      { toolName: 'sow_crop', input: { crop: 'soja', plot: 'Norte' }, originalText: 'sembré soja en Norte' },
      OPTS,
    );
    expect(r.input.crop).toBe('soja');
    expect(r.droppedFields).toEqual([]);
  });

  it('compound multi-cultivo: NO descarta el segundo cultivo', () => {
    // Bug real: extractCropFromText devolvía solo "soja" y el maíz del
    // segundo tool se descartaba como alucinación.
    const r = validateToolCall(
      { toolName: 'sow_crop', input: { crop: 'maíz', plot: 'Sur' }, originalText: 'sembré soja en Norte y maíz en Sur' },
      OPTS,
    );
    expect(r.input.crop).toBe('maíz');
    expect(r.droppedFields).toEqual([]);
  });

  it('descarta crop que el usuario nunca nombró', () => {
    const r = validateToolCall(
      { toolName: 'sow_crop', input: { crop: 'trigo', plot: 'Norte' }, originalText: 'sembré en el Norte' },
      OPTS,
    );
    expect(r.input.crop).toBeUndefined();
    expect(r.droppedFields).toContain('crop');
  });

  it('acepta sinónimos (soybean → soja)', () => {
    const r = validateToolCall(
      { toolName: 'sow_crop', input: { crop: 'soja' }, originalText: 'planté soybean en el lote' },
      OPTS,
    );
    expect(r.input.crop).toBe('soja');
  });
});

describe('agent-output-validator — plot/field', () => {
  it('mantiene plot nombrado completo en el texto', () => {
    const r = validateToolCall(
      { toolName: 'log_spraying', input: { plot: 'Norte' }, originalText: 'fumigué el lote Norte con glifosato' },
      OPTS,
    );
    expect(r.input.plot).toBe('Norte');
  });

  it('matching parcial: "el norte" valida el canónico "Lote Norte Grande"', () => {
    // El productor dice el nombre corto; el agente resuelve el canónico desde
    // su contexto. Exigir el nombre completo descartaba resoluciones legítimas.
    const r = validateToolCall(
      { toolName: 'log_spraying', input: { plot: 'Lote Norte Grande' }, originalText: 'fumigué el norte con 2,4D' },
      OPTS,
    );
    expect(r.input.plot).toBe('Lote Norte Grande');
    expect(r.droppedFields).toEqual([]);
  });

  it('tokens genéricos NO validan: decir solo "lote" no banca cualquier plot', () => {
    const r = validateToolCall(
      { toolName: 'log_spraying', input: { plot: 'Lote Norte Grande' }, originalText: 'fumigué el lote con glifosato' },
      OPTS,
    );
    expect(r.input.plot).toBeUndefined();
    expect(r.droppedFields).toContain('plot');
  });

  it('descarta plot que no aparece en el texto (anti-alucinación intacta)', () => {
    const r = validateToolCall(
      { toolName: 'log_spraying', input: { plot: 'Sur' }, originalText: 'fumigué con glifosato' },
      OPTS,
    );
    expect(r.input.plot).toBeUndefined();
  });

  it('texto expandido por el pronoun-expander valida ("en lote Norte")', () => {
    // El intent-classifier pasa el texto POST-expansión; "Norte" inyectado por
    // nuestro código debe validar igual que si el usuario lo hubiera tipeado.
    const r = validateToolCall(
      { toolName: 'log_fertilization', input: { plot: 'Norte' }, originalText: 'y en lote Norte aplique urea 100 kilos por hectarea' },
      OPTS,
    );
    expect(r.input.plot).toBe('Norte');
  });

  it('word boundary: "1B" en texto no valida el plot "1B12"', () => {
    const r = validateToolCall(
      { toolName: 'log_spraying', input: { plot: '1B12' }, originalText: 'fumigué el 1B' },
      OPTS,
    );
    expect(r.input.plot).toBeUndefined();
  });

  it('__last__ se mantiene con pronombre ("ahí")', () => {
    const r = validateToolCall(
      { toolName: 'sow_crop', input: { plot: '__last__', crop: 'soja' }, originalText: 'ahí también sembré soja' },
      OPTS,
    );
    expect(r.input.plot).toBe('__last__');
  });

  it('__last__ se mantiene con "este lote" (sync con pronoun-expander)', () => {
    const r = validateToolCall(
      { toolName: 'sow_crop', input: { plot: '__last__', crop: 'soja' }, originalText: 'en este lote sembré soja' },
      OPTS,
    );
    expect(r.input.plot).toBe('__last__');
  });

  it('__last__ se descarta sin pronombre en el texto', () => {
    const r = validateToolCall(
      { toolName: 'sow_crop', input: { plot: '__last__', crop: 'soja' }, originalText: 'sembré soja' },
      OPTS,
    );
    expect(r.input.plot).toBeUndefined();
  });

  it('tools de creación de entidades se saltean la validación', () => {
    const r = validateToolCall(
      { toolName: 'add_plot', input: { plot: 'Tommy' }, originalText: 'agregar lote tommy' },
      OPTS,
    );
    expect(r.input.plot).toBe('Tommy');
    expect(r.droppedFields).toEqual([]);
  });

  it('sin lista de plots no se descarta nada (fail-open)', () => {
    const r = validateToolCall(
      { toolName: 'log_spraying', input: { plot: 'Norte' }, originalText: 'fumigué' },
      { validatePlotField: true },
    );
    expect(r.input.plot).toBe('Norte');
  });
});
