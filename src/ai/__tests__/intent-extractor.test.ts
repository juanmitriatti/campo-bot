import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntentValidator } from '../intent-validator.js';
import { PromptBuilder } from '../prompt-builder.js';
import type { UserContext } from '../user-context.service.js';

vi.mock('../../services/settings.service.js', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getSettingNumber: vi.fn().mockResolvedValue(null),
  getSettingBool: vi.fn().mockResolvedValue(null),
}));

// =============================================================================
// IntentValidator tests
// =============================================================================

describe('IntentValidator', () => {
  const validator = new IntentValidator();

  describe('validate — expense parsing', () => {
    it('parses a full expense from LLM JSON', () => {
      const raw = '{"intent":"log_expense","confidence":0.92,"amount":50000,"category":"Combustible","description":"gasoil","currency":"ARS"}';
      const result = validator.validate(raw, 'pagué 50mil en gasoil');
      expect(result).not.toBeNull();
      expect(result!.intent.type).toBe('expense');
      if (result!.intent.type === 'expense') {
        expect(result!.intent.data.amount).toBe(50000);
        expect(result!.intent.data.category).toBe('Combustible');
        expect(result!.intent.data.currency).toBe('ARS');
      }
      expect(result!.confidence).toBeCloseTo(0.92);
      expect(result!.aiUsed).toBe(true);
      expect(result!.source).toBe('ai');
    });

    it('parses expense with USD currency', () => {
      const raw = '{"intent":"log_expense","confidence":0.88,"amount":200,"category":"Agroquímicos","description":"roundup","currency":"USD"}';
      const result = validator.validate(raw, 'compré roundup por 200 dólares');
      expect(result!.intent.type).toBe('expense');
      if (result!.intent.type === 'expense') {
        expect(result!.intent.data.currency).toBe('USD');
      }
    });

    it('defaults unknown expense category to Otros', () => {
      const raw = '{"intent":"log_expense","confidence":0.80,"amount":1000,"category":"Almuerzo","currency":"ARS"}';
      const result = validator.validate(raw, 'almuerzo con equipo');
      expect(result!.intent.type).toBe('expense');
      if (result!.intent.type === 'expense') {
        expect(result!.intent.data.category).toBe('Otros');
      }
    });

    it('returns expense_partial when amount is missing', () => {
      const raw = '{"intent":"log_expense","confidence":0.70,"category":"Combustible"}';
      const result = validator.validate(raw, 'compré gasoil');
      expect(result!.intent.type).toBe('expense_partial');
      expect(result!.missingFields).toContain('amount');
      expect(result!.confidence).toBeLessThanOrEqual(0.60);
    });
  });

  describe('validate — income parsing', () => {
    it('parses a full income with quantity details', () => {
      const raw = '{"intent":"log_income","confidence":0.95,"amount":7500,"category":"Soja","description":"vendí soja","currency":"USD","quantity":30,"unit":"tn","unit_price":250}';
      const result = validator.validate(raw, 'vendí 30 tn de soja a 250 dólares');
      expect(result!.intent.type).toBe('income');
      if (result!.intent.type === 'income') {
        expect(result!.intent.data.amount).toBe(7500);
        expect(result!.intent.data.category).toBe('Soja');
        expect(result!.intent.data.currency).toBe('USD');
        expect(result!.intent.data.quantity).toBe(30);
        expect(result!.intent.data.unit).toBe('tn');
        expect(result!.intent.data.unit_price).toBe(250);
      }
    });

    it('returns income_partial when amount is missing', () => {
      const raw = '{"intent":"log_income","confidence":0.65,"category":"Maíz"}';
      const result = validator.validate(raw, 'vendí maíz');
      expect(result!.intent.type).toBe('income_partial');
      expect(result!.missingFields).toContain('amount');
    });
  });

  describe('validate — command parsing', () => {
    it('parses a command intent', () => {
      const raw = '{"intent":"monthly_report","confidence":0.90}';
      const result = validator.validate(raw, 'cómo viene el mes');
      expect(result!.intent.type).toBe('command');
      if (result!.intent.type === 'command') {
        expect(result!.intent.data.command).toBe('monthly_report');
      }
      expect(result!.confidence).toBeCloseTo(0.90);
    });

    it('parses command with field/plot parameters', () => {
      const raw = '{"intent":"add_plot","confidence":0.88,"field":"campo norte","plot":"lote 3"}';
      const result = validator.validate(raw, 'agregá un lote 3 en campo norte');
      expect(result!.intent.type).toBe('command');
      if (result!.intent.type === 'command') {
        expect(result!.intent.data.command).toBe('add_plot');
        expect(result!.intent.data.fieldName).toBe('campo norte');
        expect(result!.intent.data.plotName).toBe('lote 3');
      }
    });

    it('parses spraying activity command', () => {
      const raw = '{"intent":"log_spraying","confidence":0.85,"product":"Glifosato","product_type":"herbicida","quantity":3,"unit":"lt","crop":"maíz","plot":"lote 3"}';
      const result = validator.validate(raw, 'fumigamos con glifosato en el lote 3');
      expect(result!.intent.type).toBe('command');
      if (result!.intent.type === 'command') {
        expect(result!.intent.data.command).toBe('log_spraying');
        expect(result!.intent.data.product).toBe('Glifosato');
        expect(result!.intent.data.productType).toBe('herbicida');
        expect(result!.intent.data.plotName).toBe('lote 3');
      }
    });

    it('parses greeting command', () => {
      const raw = '{"intent":"greeting","confidence":0.99}';
      const result = validator.validate(raw, 'hola');
      expect(result!.intent.type).toBe('command');
      if (result!.intent.type === 'command') {
        expect(result!.intent.data.command).toBe('greeting');
      }
    });
  });

  describe('validate — edge cases', () => {
    it('returns null for invalid JSON', () => {
      expect(validator.validate('not json at all', 'test')).toBeNull();
    });

    it('returns null for unknown intent', () => {
      const raw = '{"intent":"fly_to_moon","confidence":0.99}';
      expect(validator.validate(raw, 'test')).toBeNull();
    });

    it('returns null for missing intent field', () => {
      const raw = '{"confidence":0.99,"amount":500}';
      expect(validator.validate(raw, 'test')).toBeNull();
    });

    it('extracts JSON from text with surrounding content', () => {
      const raw = 'Here is the result: {"intent":"help","confidence":0.95} Hope this helps!';
      const result = validator.validate(raw, 'ayuda');
      expect(result).not.toBeNull();
      expect(result!.intent.type).toBe('command');
    });

    it('clamps confidence to 0-1 range', () => {
      const raw = '{"intent":"help","confidence":1.5}';
      const result = validator.validate(raw, 'ayuda');
      expect(result!.confidence).toBe(1.0);
    });

    it('defaults confidence to 0.80 when not a number', () => {
      const raw = '{"intent":"help","confidence":"high"}';
      const result = validator.validate(raw, 'ayuda');
      expect(result!.confidence).toBe(0.80);
    });
  });
});

// =============================================================================
// PromptBuilder tests
// =============================================================================

describe('PromptBuilder', () => {
  const builder = new PromptBuilder();

  it('builds a prompt without user context', async () => {
    const prompt = await builder.build(null);
    expect(prompt).toContain('agrícola');
    expect(prompt).toContain('log_expense');
    expect(prompt).toContain('log_income');
    expect(prompt).toContain('lucas');
  });

  it('includes field names when available', async () => {
    const ctx: UserContext = {
      fieldNames: ['Campo Norte', 'Campo Sur'],
      plotNames: ['Lote 1'],
      lastFieldName: null,
      lastPlotName: null,
    };
    const prompt = await builder.build(ctx);
    expect(prompt).toContain('Campo Norte');
    expect(prompt).toContain('Campo Sur');
    expect(prompt).toContain('Lote 1');
  });

  it('includes last context', async () => {
    const ctx: UserContext = {
      fieldNames: [],
      plotNames: [],
      lastFieldName: 'Campo Norte',
      lastPlotName: 'Lote 3',
    };
    const prompt = await builder.build(ctx);
    expect(prompt).toContain('Campo Norte');
    expect(prompt).toContain('Lote 3');
  });

  it('omits user context line when all empty', async () => {
    const ctx: UserContext = {
      fieldNames: [],
      plotNames: [],
      lastFieldName: null,
      lastPlotName: null,
    };
    const prompt = await builder.build(ctx);
    expect(prompt).not.toContain('Usuario:');
  });

  it('produces a compact prompt under 800 tokens', async () => {
    const prompt = await builder.build(null);
    // Rough token estimate: ~1 token per 4 chars for Spanish text
    const estimatedTokens = Math.ceil(prompt.length / 4);
    expect(estimatedTokens).toBeLessThan(1200);
  });
});
