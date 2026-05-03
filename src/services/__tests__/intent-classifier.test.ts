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

  // weather_full, monthly_report removed from regex — now AI-only intents

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

  // Expense/income regex parsing removed from classifier — now AI-only intents
});

describe('IntentClassifier — Phase 3 access gate', () => {
  it('grandfathered users (no subscription row) flow through the normal pipeline', async () => {
    // Without a real DB, getUserAccessMode catches the SELECT failure and
    // fails open ('full'). 'ayuda' should classify as a help command.
    const result = await classifier.classify('ayuda', userId, defaultSettings);
    expect(result.intent.type).toBe('command');
    if (result.intent.type === 'command') {
      expect(result.intent.data.command).toBe('help');
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
        data: { command: 'help' },
      },
      confidence: 0.50, // Below AI_INTENT_MIN_CONFIDENCE default of 0.70
      aiUsed: true,
      source: 'ai',
      missingFields: [],
    };
    mockExtractor.extract.mockResolvedValueOnce(lowConfResult);

    const classifierWithAI = new IntentClassifier(parser, mockUserRepo, mockExtractor);
    // "ayuda" will match regex as help command
    const { intent, aiUsed } = await classifierWithAI.classify(
      'ayuda',
      userId,
      defaultSettings
    );

    // Should fall back to regex (trivial command bypass catches "ayuda")
    expect(intent.type).toBe('command');
    if (intent.type === 'command') expect(intent.data.command).toBe('help');
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
    // Use a message that matches regex command parser
    const { intent, aiUsed } = await classifierWithAI.classify(
      'borrar ultimo gasto',
      userId,
      defaultSettings
    );

    expect(intent.type).toBe('command');
    if (intent.type === 'command') expect(intent.data.command).toBe('delete_last');
    expect(aiUsed).toBe(false);
  });
});
