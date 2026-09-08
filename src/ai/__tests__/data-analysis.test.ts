import { describe, it, expect, vi, beforeEach } from 'vitest';

const { settingsMock, saveAiUsageMock, saveAiFallbackLogMock } = vi.hoisted(() => ({
  settingsMock: {
    getSetting: vi.fn(async (): Promise<string | null> => null),
    getSettingNumber: vi.fn(async (): Promise<number | null> => null),
    getSettingBool: vi.fn(async (): Promise<boolean> => true),
  },
  saveAiUsageMock: vi.fn(async () => undefined),
  saveAiFallbackLogMock: vi.fn(async () => undefined),
}));
vi.mock('../../services/settings.service.js', () => settingsMock);
vi.mock('../../services/expenses.js', () => ({ saveAiUsage: saveAiUsageMock, saveAiFallbackLog: saveAiFallbackLogMock }));
vi.mock('../../services/error-logger.js', () => ({ logError: vi.fn() }));

import { DataAnalysisService, normalizeHistory, SYSTEM_RULES } from '../data-analysis.service.js';

function fakeClient(text: string, stopReason = 'end_turn') {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text }],
        stop_reason: stopReason,
        usage: { input_tokens: 9000, output_tokens: 500, cache_read_input_tokens: 8500, cache_creation_input_tokens: 0 },
      })),
    },
  };
}

const baseArgs = { question: '¿Qué gasto creció más?', history: [], dataJson: '{"meta":{}}', truncation: [] };

describe('DataAnalysisService', () => {
  let svc: DataAnalysisService;
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.getSettingBool.mockResolvedValue(true);
    settingsMock.getSetting.mockResolvedValue(null);
    settingsMock.getSettingNumber.mockResolvedValue(null);
    svc = new DataAnalysisService();
  });

  it('feliz: devuelve el markdown, registra uso con el costo del modelo y el log del admin', async () => {
    const client = fakeClient('## Gastos\n\n| Cat | Total |\n|---|---|\n| Gasoil | $ 1.000 ARS |');
    svc.setClientForTests(client);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const out = await svc.analyze(7, baseArgs);

    expect(out?.answer).toContain('## Gastos');
    expect(out?.model).toBe('claude-sonnet-5');
    expect(out?.truncated).toBe(false);
    expect(saveAiUsageMock).toHaveBeenCalledWith(7, expect.objectContaining({ input_tokens: 9000, cache_read_tokens: 8500 }), expect.any(Number));
    // Sonnet 5: 9000 in × $2/M + 500 out × $10/M + 8500 cache read × $0.2/M
    const cost = saveAiUsageMock.mock.calls[0][2] as number;
    expect(cost).toBeCloseTo(0.018 + 0.005 + 0.0017, 4);
    expect(saveAiFallbackLogMock).toHaveBeenCalledOnce();
    expect(String(saveAiFallbackLogMock.mock.calls[0][1])).toContain('"type":"data_analysis"');
    logSpy.mockRestore();
  });

  it('kill switch DATA_ANALYSIS_ENABLED=false → null sin llamar a la API, con log [INTERCEPT]', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    settingsMock.getSettingBool.mockResolvedValue(false);
    const client = fakeClient('no');
    svc.setClientForTests(client);
    expect(await svc.analyze(1, baseArgs)).toBeNull();
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[INTERCEPT]'));
    logSpy.mockRestore();
  });

  it('error/timeout de la API → null (la ruta arma el 503, nunca throw)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.setClientForTests({ messages: { create: vi.fn(async () => { throw new Error('timeout'); }) } });
    expect(await svc.analyze(1, baseArgs)).toBeNull();
    errSpy.mockRestore();
  });

  it('refusal → null; max_tokens → respuesta con la nota de recorte', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    svc.setClientForTests(fakeClient('x', 'refusal'));
    expect(await svc.analyze(1, baseArgs)).toBeNull();

    svc.setClientForTests(fakeClient('Análisis largo', 'max_tokens'));
    const out = await svc.analyze(1, baseArgs);
    expect(out?.truncated).toBe(true);
    expect(out?.answer).toContain('respuesta recortada por largo');
    logSpy.mockRestore();
  });

  it('cache: DATOS lleva cache_control y la fecha va en el ÚLTIMO mensaje user, nunca en system', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = fakeClient('ok');
    svc.setClientForTests(client);
    settingsMock.getSetting.mockImplementation(async (k: string) => (k === 'DATA_ANALYSIS_EFFORT' ? 'high' : null));

    await svc.analyze(1, { ...baseArgs, truncation: [{ list: 'expenses', kept: 75, total: 150 }] });

    const call = client.messages.create.mock.calls[0][0] as {
      system: Array<{ text: string; cache_control?: unknown }>;
      messages: Array<{ role: string; content: string }>;
      output_config: { effort: string };
    };
    expect(call.system[0].text).toBe(SYSTEM_RULES);
    expect(call.system[0].cache_control).toBeUndefined();
    expect(call.system[1].text).toContain('DATOS DEL USUARIO');
    expect(call.system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(call.system.map((b) => b.text).join('\n')).not.toMatch(/Hoy es/);
    const last = call.messages[call.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toMatch(/^Hoy es \d{2}\/\d{2}\/\d{4}\./);
    expect(last.content).toContain('expenses: 75 de 150 filas');
    expect(last.content).toContain('Pregunta: ¿Qué gasto creció más?');
    expect(call.output_config.effort).toBe('high');
    logSpy.mockRestore();
  });

  it('las reglas duras están en el system: no inventar, no dosis, no "registré"', () => {
    expect(SYSTEM_RULES).toContain('NUNCA inventes cifras');
    expect(SYSTEM_RULES).toContain('NUNCA des dosis');
    expect(SYSTEM_RULES).toContain('marbete');
    expect(SYSTEM_RULES).toContain('NUNCA digas que registraste');
  });
});

describe('normalizeHistory', () => {
  it('alterna user/assistant, recorta al tope y termina en assistant', () => {
    const h = normalizeHistory([
      { role: 'assistant', content: 'huérfano' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'a2' },          // reintento: se queda el último
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'pendiente' },   // sin respuesta: se tira
    ], 1);
    expect(h).toEqual([{ role: 'user', content: 'b' }, { role: 'assistant', content: 'r2' }]);
  });

  it('descarta roles inválidos y contenido vacío; recorta turnos largos', () => {
    const long = 'x'.repeat(5000);
    const h = normalizeHistory([
      { role: 'system' as 'user', content: 'no' },
      { role: 'user', content: '   ' },
      { role: 'user', content: long },
      { role: 'assistant', content: 'ok' },
    ], 6);
    expect(h).toHaveLength(2);
    expect(h[0].content).toHaveLength(4000);
  });
});
