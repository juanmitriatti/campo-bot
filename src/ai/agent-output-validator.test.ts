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

  // Bug live (Ago 2026): "Quiero sembrar soja" → "¿En qué lote?" → "Norte".
  // El agente arma sow_crop(crop=soja, plot=Norte) en el 2º turno, pero el
  // validador dropeaba "soja" porque no está en "Norte" (no veía el historial)
  // → re-preguntaba el cultivo y ofrecía el form sin prefill. El crop que el
  // usuario dijo un turno antes NO es alucinación.
  it('no dropea el crop que el usuario nombró en un turno reciente (recentText)', () => {
    const r = validateToolCall(
      { toolName: 'sow_crop', input: { crop: 'soja', plot: 'Norte' }, originalText: 'Norte' },
      { ...OPTS, recentText: 'Quiero sembrar soja' },
    );
    expect(r.input.crop).toBe('soja');
    expect(r.droppedFields).not.toContain('crop');
  });

  it('sí dropea si el crop no está ni en el texto ni en el historial reciente', () => {
    const r = validateToolCall(
      { toolName: 'sow_crop', input: { crop: 'trigo', plot: 'Norte' }, originalText: 'Norte' },
      { ...OPTS, recentText: 'quiero sembrar soja' },
    );
    expect(r.input.crop).toBeUndefined();
    expect(r.droppedFields).toContain('crop');
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

  describe('resolución de contexto (deíctico) — solución generalizada Jun 2026', () => {
    it('"el otro lote" + plot real NO se dropea aunque no esté literal', () => {
      // Bug live: "en el otro lote sembré maíz" → agente resuelve plot=Sur,
      // el validador lo dropeaba → maíz al lote equivocado.
      const r = validateToolCall(
        { toolName: 'sow_crop', input: { plot: 'Sur', crop: 'maíz' }, originalText: 'en el otro lote sembre maiz' },
        OPTS,
      );
      expect(r.input.plot).toBe('Sur');
    });

    it('"ahí también" + plot real se mantiene (variante que el expander pudo no cubrir)', () => {
      const r = validateToolCall(
        { toolName: 'log_spraying', input: { plot: 'Norte' }, originalText: 'ahi tambien fumigue con glifosato' },
        OPTS,
      );
      expect(r.input.plot).toBe('Norte');
    });

    it('SIN deíctico ni mención → sigue dropeando (anti-alucinación intacta)', () => {
      const r = validateToolCall(
        { toolName: 'log_expense', input: { plot: 'Norte' }, originalText: 'gasté 50 mil en sueldos' },
        OPTS,
      );
      expect(r.input.plot).toBeUndefined();
    });

    it('plot inexistente + deíctico → dropea igual (no es lote del usuario)', () => {
      const r = validateToolCall(
        { toolName: 'log_spraying', input: { plot: 'Fantasma' }, originalText: 'ahi fumigue' },
        OPTS,
      );
      expect(r.input.plot).toBeUndefined();
    });
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
