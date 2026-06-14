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

describe('IntentClassifier — Phase 2 fallback gating', () => {
  // No extractor, no agent → goes straight to regex fallback (step 4).

  it('blocks generate_agro_report when AI is unavailable (returns fallback_blocked)', async () => {
    const result = await classifier.classify('reporte agronomico del lote norte', userId, defaultSettings);
    expect(result.intent.type).toBe('fallback_blocked');
    if (result.intent.type === 'fallback_blocked') {
      expect(result.intent.reason).toBe('ai_required');
      expect(result.intent.attemptedCommand).toBe('generate_agro_report');
      expect(result.intent.raw).toBe('reporte agronomico del lote norte');
    }
    expect(result.confidence).toBe(0);
    expect(result.aiUsed).toBe(false);
  });

  // Note: weather_* commands are listed in SAFE_FALLBACK_INTENTS but the
  // current parser doesn't actually emit them via parseCommand (the
  // dispatchWeather helper isn't wired into the COMMAND_PATTERNS table
  // anymore — weather is AI-only today). The whitelist entries are
  // future-proofing in case wiring is restored. So we don't assert on
  // weather here; query_plot_history below covers the read-only-SAFE case.

  it('allows query_plot_history through the fallback (read-only)', async () => {
    const result = await classifier.classify('cuando se fumigo en el lote norte', userId, defaultSettings);
    expect(result.intent.type).toBe('command');
    if (result.intent.type === 'command') {
      expect(result.intent.data.command).toBe('query_plot_history');
    }
  });

  it('does NOT attempt to parse "gasté 50000 en gasoil" via fallback (financial = AI required)', async () => {
    // The regex parser doesn't have an expense pattern for this anymore (Phase A
    // refactor removed it). The classifier's fallback either returns
    // fallback_blocked (if some other rule triggered) or unknown (no match).
    // What it MUST NEVER return is a partially-parsed expense intent.
    const result = await classifier.classify('gaste 50000 en gasoil', userId, defaultSettings);
    expect(result.intent.type).not.toBe('expense');
    expect(result.intent.type).not.toBe('expense_partial');
    if (result.intent.type === 'command') {
      // Must not have parsed log_expense or any other financial cmd
      expect(result.intent.data.command).not.toBe('log_expense');
      expect(result.intent.data.command).not.toBe('log_income');
    }
  });

  it('still allows log_observation via "observación:" prefix (text-only safe)', async () => {
    const result = await classifier.classify('observacion: vi rama negra en lote sur', userId, defaultSettings);
    expect(result.intent.type).toBe('command');
    if (result.intent.type === 'command') {
      expect(result.intent.data.command).toBe('log_observation');
    }
  });
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

  // Guard anti-saludo-goloso (Martin, Jun 2026): "buenas anotame 150000 dolares
  // de soja..." se clasificaba como greeting y el ingreso se perdía. Un saludo
  // que PREFIJA una acción real NO debe cortocircuitar a greeting.
  it('greeting + acción real NO se trata como greeting (va al extractor)', async () => {
    const classifierWithAI = new IntentClassifier(parser, mockUserRepo, mockExtractor);
    mockExtractor.extract.mockResolvedValueOnce({
      intent: { type: 'income', data: { type: 'income', amount: 150000, currency: 'USD', category: 'Soja', description: 'soja' } },
      confidence: 0.9, missingFields: [],
    });
    await classifierWithAI.classify('buenas anotame 150000 dolares de soja para el lote 1', userId, defaultSettings);
    // El extractor AI SÍ debe haber sido llamado (no quedó atrapado en greeting)
    expect(mockExtractor.extract).toHaveBeenCalled();
  });

  it('saludo puro (con nombre/muletilla) SIGUE siendo greeting', async () => {
    const classifierWithAI = new IntentClassifier(parser, mockUserRepo, mockExtractor);
    for (const msg of ['hola mia', 'buen dia mia', 'buenas tardes', 'hola como va', 'buenas che']) {
      mockExtractor.extract.mockClear();
      const { intent } = await classifierWithAI.classify(msg, userId, defaultSettings);
      expect(intent.type).toBe('command');
      if (intent.type === 'command') expect(intent.data.command).toBe('greeting');
      expect(mockExtractor.extract).not.toHaveBeenCalled();
    }
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
