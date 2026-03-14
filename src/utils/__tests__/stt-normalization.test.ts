import { describe, it, expect, vi } from 'vitest';
import { fixCommonTypos, parseCommand } from '../parser.js';
import { stripFillerPhrases, normalizePlotNumbers, normalizeTranscript } from '../text-normalizer.js';
import { IntentClassifier } from '../../services/intent-classifier.js';
import { ParserService } from '../../services/parser.service.js';
import type { UserId, UserSettings } from '../../types/index.js';

// --- fixCommonTypos: STT misspellings ---
describe('fixCommonTypos — STT lote misspellings', () => {
  it('"lot 3" → "lote 3"', () => {
    expect(fixCommonTypos('lot 3')).toBe('lote 3');
  });

  it('"lotee 5" → "lote 5"', () => {
    expect(fixCommonTypos('lotee 5')).toBe('lote 5');
  });

  it('"loteh 2" → "lote 2"', () => {
    expect(fixCommonTypos('loteh 2')).toBe('lote 2');
  });

  it('"plot 2" → "lote 2"', () => {
    expect(fixCommonTypos('plot 2')).toBe('lote 2');
  });

  it('"info lot 3" → "info lote 3"', () => {
    expect(fixCommonTypos('info lot 3')).toBe('info lote 3');
  });
});

// --- stripFillerPhrases: preserves lote/campo context ---
describe('stripFillerPhrases — lote/campo preservation', () => {
  it('"info lote 3" is preserved', () => {
    expect(stripFillerPhrases('info lote 3')).toBe('info lote 3');
  });

  it('"info del campo norte" is preserved', () => {
    expect(stripFillerPhrases('info del campo norte')).toBe('info del campo norte');
  });

  it('"datos del lote 5" is preserved', () => {
    expect(stripFillerPhrases('datos del lote 5')).toBe('datos del lote 5');
  });

  it('"info de mis gastos" is still stripped', () => {
    expect(stripFillerPhrases('info de mis gastos')).toBe('mis gastos');
  });

  it('"dame info de mis campos" strips "dame" prefix', () => {
    const result = stripFillerPhrases('dame info de mis campos');
    // "dame" is stripped by second regex, but "info de mis campos" stays (contains "campo")
    // Actually "dame info de mis campos" — first regex: "dame info de " but "mis campos" doesn't start with lote/campo/parcela right after "de"
    // Wait, let me think: the first regex matches "dame info de " → but lookahead checks what follows "de " → "mis" not lote/campo → strips
    // Result: "mis campos"
    // Then second regex doesn't match since it starts with "mis"
    expect(result).toBe('mis campos');
  });
});

// --- normalizePlotNumbers ---
describe('normalizePlotNumbers', () => {
  it('"lote tres" → "lote 3"', () => {
    expect(normalizePlotNumbers('lote tres')).toBe('lote 3');
  });

  it('"lote diez" → "lote 10"', () => {
    expect(normalizePlotNumbers('lote diez')).toBe('lote 10');
  });

  it('"lote uno" → "lote 1"', () => {
    expect(normalizePlotNumbers('lote uno')).toBe('lote 1');
  });

  it('"compre tres bolsas" stays unchanged', () => {
    expect(normalizePlotNumbers('compre tres bolsas')).toBe('compre tres bolsas');
  });

  it('"estado lote cinco" → "estado lote 5"', () => {
    expect(normalizePlotNumbers('estado lote cinco')).toBe('estado lote 5');
  });
});

// --- parseCommand: new patterns ---
describe('parseCommand — new STT-friendly patterns', () => {
  it('"estado lote 3" → plot_info', () => {
    const result = parseCommand('estado lote 3');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('plot_info');
    expect(result!.plotName).toBe('3');
  });

  it('"como viene el lote 3" → plot_info', () => {
    const result = parseCommand('como viene el lote 3');
    expect(result).not.toBeNull();
    // plot_info pattern matches first since it's defined before field_info
    expect(result!.command).toBe('plot_info');
    expect(result!.plotName).toBe('3');
  });

  it('"informe lote 2" → plot_info', () => {
    const result = parseCommand('informe lote 2');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('plot_info');
    expect(result!.plotName).toBe('2');
  });

  it('"actividad lote 2" → plot_activities', () => {
    const result = parseCommand('actividad lote 2');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('plot_activities');
  });

  it('"estado campo norte" → field_info', () => {
    const result = parseCommand('estado campo norte');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('field_info');
    expect(result!.entityKeyword).toBe('campo');
    expect(result!.fieldName).toBe('norte');
  });
});

// --- IntentClassifier: intelligent fallback ---
describe('IntentClassifier — intelligent fallback for bare plot references', () => {
  const mockUserRepo = {
    getDailyClaudeCount: vi.fn().mockResolvedValue(0),
    saveAiUsage: vi.fn(),
    getOrCreate: vi.fn(),
    setName: vi.fn(),
    setCity: vi.fn(),
    getSettings: vi.fn(),
    updateSetting: vi.fn(),
  } as any;

  const parser = new ParserService();
  const classifier = new IntentClassifier(parser, mockUserRepo);
  const defaultSettings = { claude_daily_limit: 50 } as UserSettings;
  const userId = 1 as UserId;

  it('"y lote 3" → plot_info via intelligent fallback', async () => {
    // "y lote 3" — after stripping "lote 3", observation text is "y" (< 3 chars) → rejected
    // Falls through to intelligent fallback which detects plot reference
    const { intent, confidence } = await classifier.classify('y lote 3', userId, defaultSettings);
    expect(intent.type).toBe('command');
    if (intent.type === 'command') {
      expect(intent.data.command).toBe('plot_info');
      expect(intent.data.plotName).toBe('3');
    }
    expect(confidence).toBeGreaterThanOrEqual(0.70);
  });

  it('"el lote 5" → plot_info via intelligent fallback', async () => {
    const { intent } = await classifier.classify('el lote 5', userId, defaultSettings);
    expect(intent.type).toBe('command');
    if (intent.type === 'command') {
      expect(intent.data.command).toBe('plot_info');
    }
  });
});

// --- normalizeTranscript ---
describe('normalizeTranscript — STT artifact cleaning', () => {
  it('removes punctuation separators', () => {
    expect(normalizeTranscript('Reporte agronómico, campo general.')).toBe(
      'reporte agronomico campo general'
    );
  });

  it('strips accents and lowercases', () => {
    expect(normalizeTranscript('SEÑOR PRESIDENTE')).toBe('senor presidente');
  });

  it('strips leading filler words', () => {
    expect(normalizeTranscript('Eh, bueno, reporte campo')).toBe('reporte campo');
  });

  it('removes repeated consecutive words', () => {
    expect(normalizeTranscript('el el lote 3')).toBe('el lote 3');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeTranscript('reporte   campo   general')).toBe('reporte campo general');
  });

  it('handles full Whisper artifact example', () => {
    const raw = 'SEÑOR PRESIDENTE. Reporte agronómico, campo general.';
    const normalized = normalizeTranscript(raw);
    expect(normalized).toBe('senor presidente reporte agronomico campo general');
  });

  it('preserves meaningful content', () => {
    expect(normalizeTranscript('gaste 50 mil en gasoil')).toBe('gaste 50 mil en gasoil');
  });
});

// --- End-to-end: normalizeTranscript → parseCommand ---
describe('normalizeTranscript + parseCommand — end-to-end', () => {
  it('Whisper "SEÑOR PRESIDENTE. Reporte agronómico, campo general." → generate_agro_report', () => {
    const raw = 'SEÑOR PRESIDENTE. Reporte agronómico, campo general.';
    const normalized = normalizeTranscript(raw);
    const result = parseCommand(normalized);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('generate_agro_report');
  });

  it('Whisper "Eh, estado del lote 3." → plot_info', () => {
    const normalized = normalizeTranscript('Eh, estado del lote 3.');
    const result = parseCommand(normalized);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('plot_info');
    expect(result!.plotName).toBe('3');
  });
});

// --- Observation safety guard ---
describe('IntentClassifier — observation safety guard for report-like messages', () => {
  const mockUserRepo = {
    getDailyClaudeCount: vi.fn().mockResolvedValue(0),
    saveAiUsage: vi.fn(),
    getOrCreate: vi.fn(),
    setName: vi.fn(),
    setCity: vi.fn(),
    getSettings: vi.fn(),
    updateSetting: vi.fn(),
  } as any;

  const parser = new ParserService();
  const classifier = new IntentClassifier(parser, mockUserRepo);
  const defaultSettings = { claude_daily_limit: 50 } as UserSettings;
  const userId = 1 as UserId;

  it('"reporte campo general" does NOT become an observation', async () => {
    const result = await classifier.classify('reporte campo general', userId, defaultSettings);
    // Should match generate_agro_report or at least NOT be log_observation
    if (result.intent.type === 'command') {
      expect(result.intent.data.command).not.toBe('log_observation');
    }
  });

  it('"estado lote 3" does NOT become an observation', async () => {
    const result = await classifier.classify('estado lote 3', userId, defaultSettings);
    expect(result.intent.type).toBe('command');
    if (result.intent.type === 'command') {
      expect(result.intent.data.command).not.toBe('log_observation');
    }
  });
});
