import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn().mockResolvedValue('tok123');
vi.mock('../../services/form-session.service.js', () => ({
  formSessionService: { create: (...a: unknown[]) => createMock(...a) },
}));
const getSettingMock = vi.fn();
vi.mock('../../services/settings.service.js', () => ({
  getSetting: (...a: unknown[]) => getSettingMock(...a),
}));
const computeOptsMock = vi.fn();
vi.mock('../form-options.js', () => ({
  computeFormOptions: (...a: unknown[]) => computeOptsMock(...a),
}));

const { appendFormOffer } = await import('../form-offer.js');

const ctx = {
  channel: 'telegram', phone: 'tg_555', userId: 9,
  user: {}, settings: {}, startTime: 0,
} as never;

describe('appendFormOffer', () => {
  beforeEach(() => { createMock.mockClear(); getSettingMock.mockReset(); computeOptsMock.mockReset(); });

  it('sin offerForm no hace nada', async () => {
    const items: unknown[] = [];
    await appendFormOffer(items as never, { messages: [] } as never, ctx);
    expect(items).toHaveLength(0);
  });

  it('con offerForm crea sesión y agrega botón web_app', async () => {
    getSettingMock.mockResolvedValue('https://campo.test');
    const items: unknown[] = [];
    const response = {
      messages: ['🌱 ¿Qué cultivo sembraste?'],
      sideEffects: {
        offerForm: { action: 'sow_crop', prefill: { plotName: 'Norte' } },
        setPendingActivity: { command: 'sow_crop', data: {}, missing: ['crop'] },
      },
    };
    await appendFormOffer(items as never, response as never, ctx);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 9, action: 'sow_crop', channel: 'telegram',
      channelId: '555', phone: 'tg_555', hadPending: true,
    }));
    expect(items).toHaveLength(1);
    const item = items[0] as { interactive: { buttons: Array<{ webAppUrl?: string }> } };
    expect(item.interactive.buttons[0].webAppUrl).toBe('https://campo.test/form/tok123');
  });

  it('sin PUBLIC_URL no ofrece y loguea', async () => {
    getSettingMock.mockResolvedValue(null);
    const items: unknown[] = [];
    await appendFormOffer(items as never, {
      messages: [], sideEffects: { offerForm: { action: 'sow_crop', prefill: {} } },
    } as never, ctx);
    expect(items).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  const waCtx = { ...(ctx as object), channel: 'whatsapp', phone: '549341...' } as never;

  it('en whatsapp con flow_id configurado envía un Flow con opciones horneadas', async () => {
    getSettingMock.mockImplementation(async (k: string) =>
      k === 'WHATSAPP_FLOW_ID_SOW' ? 'flow_sow_123' : null);
    computeOptsMock.mockResolvedValue({
      plots: [{ id: 7, name: 'Norte', fieldName: 'La Barrida', activeCrop: null }],
      crops: ['soja', 'maíz'],
    });
    const items: unknown[] = [];
    await appendFormOffer(items as never, {
      messages: [], sideEffects: { offerForm: { action: 'sow_crop', prefill: {} } },
    } as never, waCtx);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'whatsapp', action: 'sow_crop',
    }));
    expect(items).toHaveLength(1);
    const item = items[0] as { interactive: { type: string; flow: { flowId: string; flowToken: string; mode: string; data: Record<string, unknown> } } };
    expect(item.interactive.type).toBe('flow');
    expect(item.interactive.flow.flowId).toBe('flow_sow_123');
    expect(item.interactive.flow.flowToken).toBe('tok123');
    expect(item.interactive.flow.mode).toBe('published');
    expect(item.interactive.flow.data.plot_id_options).toEqual([{ id: '7', title: 'Norte (La Barrida)' }]);
    expect(item.interactive.flow.data.crop_options).toEqual([{ id: 'soja', title: 'soja' }, { id: 'maíz', title: 'maíz' }]);
  });

  it('en whatsapp sin flow_id configurado no ofrece', async () => {
    getSettingMock.mockResolvedValue(null);
    const items: unknown[] = [];
    await appendFormOffer(items as never, {
      messages: [], sideEffects: { offerForm: { action: 'sow_crop', prefill: {} } },
    } as never, waCtx);
    expect(items).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
  });
});
