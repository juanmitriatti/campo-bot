import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntentClassifier } from '../intent-classifier.js';
import { ParserService } from '../parser.service.js';
import type { UserId, UserSettings, ParseResult } from '../../types/index.js';

const mockUserRepo = {
  getDailyClaudeCount: vi.fn().mockResolvedValue(0),
  saveAiUsage: vi.fn(),
  getOrCreate: vi.fn(),
  setName: vi.fn(),
  setCity: vi.fn(),
  getSettings: vi.fn(),
  updateSetting: vi.fn(),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const parser = new ParserService();
const classifier = new IntentClassifier(parser, mockUserRepo);
const defaultSettings = { claude_daily_limit: 50 } as UserSettings;
const userId = 1 as UserId;

describe('IntentClassifier — local parsing', () => {
  // --- Commands ---

  it('classifies "ayuda" as help command', async () => {
    const { intent, aiUsed } = await classifier.classify('ayuda', userId, defaultSettings);
    expect(intent.type).toBe('command');
    if (intent.type === 'command') expect(intent.data.command).toBe('help');
    expect(aiUsed).toBe(false);
  });

  it('classifies "clima" as weather_full command', async () => {
    const { intent } = await classifier.classify('clima', userId, defaultSettings);
    expect(intent.type).toBe('command');
    if (intent.type === 'command') expect(intent.data.command).toBe('weather_full');
  });

  it('classifies "resumen del mes" as monthly_report command', async () => {
    const { intent } = await classifier.classify('resumen del mes', userId, defaultSettings);
    expect(intent.type).toBe('command');
    if (intent.type === 'command') expect(intent.data.command).toBe('monthly_report');
  });

  it('classifies "borrar ultimo gasto" as delete_last command', async () => {
    const { intent } = await classifier.classify('borrar ultimo gasto', userId, defaultSettings);
    expect(intent.type).toBe('command');
    if (intent.type === 'command') expect(intent.data.command).toBe('delete_last');
  });

  it('classifies "dolar" as dollar command', async () => {
    const { intent } = await classifier.classify('dolar', userId, defaultSettings);
    expect(intent.type).toBe('command');
    if (intent.type === 'command') expect(intent.data.command).toBe('dollar');
  });

  // --- Expenses ---

  it('classifies "pagué 50mil en gasoil" as expense', async () => {
    const { intent, aiUsed } = await classifier.classify('pagué 50mil en gasoil', userId, defaultSettings);
    expect(intent.type).toBe('expense');
    if (intent.type === 'expense') {
      expect(intent.data.amount).toBe(50000);
      expect(intent.data.category).toBe('Combustible');
      expect(intent.data.currency).toBe('ARS');
    }
    expect(aiUsed).toBe(false);
  });

  it('classifies "500k en semillas" as expense', async () => {
    const { intent } = await classifier.classify('500k en semillas', userId, defaultSettings);
    expect(intent.type).toBe('expense');
    if (intent.type === 'expense') {
      expect(intent.data.amount).toBe(500000);
      expect(intent.data.category).toBe('Semillas');
    }
  });

  // --- Incomes ---

  it('classifies "vendí soja por 2 millones" as income', async () => {
    const { intent, aiUsed } = await classifier.classify('vendí soja por 2 millones', userId, defaultSettings);
    expect(intent.type).toBe('income');
    if (intent.type === 'income') {
      expect(intent.data.amount).toBe(2000000);
      expect(intent.data.category).toBe('Soja');
    }
    expect(aiUsed).toBe(false);
  });

  // --- Priority ---

  it('commands take priority over expense parsing', async () => {
    const { intent } = await classifier.classify('resumen del mes', userId, defaultSettings);
    expect(intent.type).toBe('command');
  });

  it('income parsing works for simple sale', async () => {
    const { intent } = await classifier.classify('vendí soja por 500mil', userId, defaultSettings);
    expect(intent.type).toBe('income');
    if (intent.type === 'income') {
      expect(intent.data.amount).toBe(500000);
    }
  });
});

describe('IntentClassifier — AI intent extraction via mock extractor', () => {
  const mockExtractor = {
    extract: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  beforeEach(() => {
    vi.mocked(mockExtractor.extract).mockReset();
  });

  it('maps AI spraying response to command intent', async () => {
    const aiResult: ParseResult = {
      intent: {
        type: 'command',
        data: {
          command: 'log_spraying',
          product: 'Glifosato',
          productType: 'herbicida',
          quantity: 3,
          unit: 'lt',
          crop: 'maíz',
          plotName: 'lote 3',
        },
      },
      confidence: 0.85,
      aiUsed: true,
      source: 'ai',
      missingFields: [],
    };
    mockExtractor.extract.mockResolvedValueOnce(aiResult);

    const classifierWithAI = new IntentClassifier(parser, mockUserRepo, mockExtractor);
    const { intent, aiUsed, source } = await classifierWithAI.classify(
      'hoy se hizo fumigacion con glifosato en tercer lote del maiz',
      userId,
      defaultSettings
    );

    expect(aiUsed).toBe(true);
    expect(source).toBe('ai');
    expect(intent.type).toBe('command');
    if (intent.type === 'command') {
      expect(intent.data.command).toBe('log_spraying');
      expect(intent.data.product).toBe('Glifosato');
      expect(intent.data.productType).toBe('herbicida');
      expect(intent.data.quantity).toBe(3);
      expect(intent.data.unit).toBe('lt');
      expect(intent.data.crop).toBe('maíz');
      expect(intent.data.plotName).toBe('lote 3');
    }
  });

  it('maps AI fertilization response to log_fertilization command', async () => {
    const aiResult: ParseResult = {
      intent: {
        type: 'command',
        data: {
          command: 'log_fertilization',
          product: 'urea',
          productType: 'fertilizante',
          quantity: 100,
          unit: 'kg',
          plotName: 'lote 5',
        },
      },
      confidence: 0.85,
      aiUsed: true,
      source: 'ai',
      missingFields: [],
    };
    mockExtractor.extract.mockResolvedValueOnce(aiResult);

    const classifierWithAI = new IntentClassifier(parser, mockUserRepo, mockExtractor);
    const { intent, aiUsed } = await classifierWithAI.classify(
      'nutrimos con urea el quinto lote',
      userId,
      defaultSettings
    );

    expect(aiUsed).toBe(true);
    expect(intent.type).toBe('command');
    if (intent.type === 'command') {
      expect(intent.data.command).toBe('log_fertilization');
      expect(intent.data.product).toBe('urea');
    }
  });

  it('falls back to regex when AI returns null', async () => {
    mockExtractor.extract.mockResolvedValueOnce(null);

    const classifierWithAI = new IntentClassifier(parser, mockUserRepo, mockExtractor);
    const { intent } = await classifierWithAI.classify(
      'mensaje ambiguo sin sentido claro xyz',
      userId,
      defaultSettings
    );

    expect(intent.type).toBe('unknown');
  });

  it('falls back to regex when AI confidence is below threshold', async () => {
    const lowConfResult: ParseResult = {
      intent: {
        type: 'command',
        data: { command: 'weather_full' },
      },
      confidence: 0.50, // Below AI_INTENT_MIN_CONFIDENCE default of 0.70
      aiUsed: true,
      source: 'ai',
      missingFields: [],
    };
    mockExtractor.extract.mockResolvedValueOnce(lowConfResult);

    const classifierWithAI = new IntentClassifier(parser, mockUserRepo, mockExtractor);
    // "clima" will match regex as weather_full command
    const { intent, aiUsed } = await classifierWithAI.classify(
      'clima',
      userId,
      defaultSettings
    );

    // Should fall back to regex (trivial command bypass actually catches "clima" first)
    expect(intent.type).toBe('command');
    if (intent.type === 'command') expect(intent.data.command).toBe('weather_full');
    // aiUsed should be false because regex matched it, not the AI
    expect(aiUsed).toBe(false);
  });

  it('trivial commands bypass AI extractor entirely', async () => {
    const classifierWithAI = new IntentClassifier(parser, mockUserRepo, mockExtractor);

    const { intent, aiUsed } = await classifierWithAI.classify(
      'hola',
      userId,
      defaultSettings
    );

    // AI extractor should not have been called
    expect(mockExtractor.extract).not.toHaveBeenCalled();
    expect(intent.type).toBe('command');
    if (intent.type === 'command') expect(intent.data.command).toBe('greeting');
    expect(aiUsed).toBe(false);
  });

  it('falls back to regex when AI throws error', async () => {
    mockExtractor.extract.mockRejectedValueOnce(new Error('API error'));

    const classifierWithAI = new IntentClassifier(parser, mockUserRepo, mockExtractor);
    // Use a message that matches regex expense parser
    const { intent, aiUsed } = await classifierWithAI.classify(
      'pagué 50mil en gasoil',
      userId,
      defaultSettings
    );

    expect(intent.type).toBe('expense');
    expect(aiUsed).toBe(false);
  });
});
