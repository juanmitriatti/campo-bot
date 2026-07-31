import { describe, it, expect, vi, beforeEach } from 'vitest';

const { settingsMock, saveAiUsageMock } = vi.hoisted(() => ({
  settingsMock: {
    getSetting: vi.fn(async (): Promise<string | null> => null),
    getSettingNumber: vi.fn(async (): Promise<number | null> => null),
    getSettingBool: vi.fn(async (): Promise<boolean> => true),
  },
  saveAiUsageMock: vi.fn(async () => undefined),
}));
vi.mock('../../services/settings.service.js', () => settingsMock);
vi.mock('../../services/expenses.js', () => ({ saveAiUsage: saveAiUsageMock }));
vi.mock('../../services/error-logger.js', () => ({ logError: vi.fn() }));

import { AgronomyKnowledgeService } from '../agronomy-knowledge.service.js';

function fakeClient(text: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 80 },
      })),
    },
  };
}

describe('AgronomyKnowledgeService', () => {
  let svc: AgronomyKnowledgeService;

  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.getSettingBool.mockResolvedValue(true);
    svc = new AgronomyKnowledgeService();
  });

  it('responde la pregunta con la llamada dedicada y loguea uso', async () => {
    const client = fakeClient('El *V6* es el estadio de 6 hojas desarrolladas en maíz.');
    svc.setClientForTests(client);

    const out = await svc.answer(1, '¿Qué significa V6 en maíz?');

    expect(out).toContain('V6');
    expect(client.messages.create).toHaveBeenCalledOnce();
    expect(saveAiUsageMock).toHaveBeenCalledWith(1, expect.objectContaining({ input_tokens: 100, output_tokens: 50 }));
  });

  it('kill switch: AGRONOMY_QA_ENABLED=false → null sin llamar a la API, con log [INTERCEPT]', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    settingsMock.getSettingBool.mockResolvedValue(false);
    const client = fakeClient('no debería llamarse');
    svc.setClientForTests(client);

    const out = await svc.answer(1, '¿Qué es barbecho químico?');

    expect(out).toBeNull();
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[INTERCEPT]'));
    logSpy.mockRestore();
  });

  it('pregunta vacía → null sin llamar a la API', async () => {
    const client = fakeClient('x');
    svc.setClientForTests(client);
    expect(await svc.answer(1, '   ')).toBeNull();
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('error de API → null (el handler arma el fallback, nunca throw)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.setClientForTests({ messages: { create: vi.fn(async () => { throw new Error('529'); }) } });
    expect(await svc.answer(1, '¿Cómo identificar roya?')).toBeNull();
    errSpy.mockRestore();
  });

  it('el system prompt incluye la regla de seguridad de dosis y la de no-acciones', async () => {
    const client = fakeClient('ok');
    svc.setClientForTests(client);
    await svc.answer(1, '¿Cuánto glifosato aplico?');

    const call = client.messages.create.mock.calls[0][0] as { system: Array<{ text: string }> };
    const sys = call.system.map((b) => b.text).join('\n');
    expect(sys).toContain('NUNCA des una dosis concreta');
    expect(sys).toContain('marbete');
    expect(sys).toContain('NUNCA digas que registraste');
    expect(sys).toContain('NUNCA asumís nada de su campo');
  });
});
