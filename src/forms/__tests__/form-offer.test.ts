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
const startConvMock = vi.fn().mockResolvedValue([{ type: 'text', text: '💰 ¿Cuánto gastaste?' }]);
const resumeConvMock = vi.fn().mockResolvedValue([{ type: 'text', text: '↩️ Sigamos' }]);
vi.mock('../conversation/form-conversation.service.js', () => ({
  startConversationForm: (...a: unknown[]) => startConvMock(...a),
  resumeConversationForm: (...a: unknown[]) => resumeConvMock(...a),
}));

const { appendFormOffer } = await import('../form-offer.js');

const ctx = {
  channel: 'telegram', phone: 'tg_555', userId: 9,
  user: {}, settings: {}, startTime: 0,
} as never;

describe('appendFormOffer', () => {
  beforeEach(() => {
    createMock.mockClear(); getSettingMock.mockReset(); computeOptsMock.mockReset();
    startConvMock.mockClear(); resumeConvMock.mockClear();
  });

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

  it('en whatsapp con provider meta_flow + flow_id envía un Flow con opciones horneadas (preservado)', async () => {
    getSettingMock.mockImplementation(async (k: string) =>
      k === 'WHATSAPP_FLOW_ID_SOW' ? 'flow_sow_123' : k === 'WHATSAPP_FORM_PROVIDER' ? 'meta_flow' : null);
    computeOptsMock.mockResolvedValue({
      plots: [{ id: 7, name: 'Norte', fieldId: 1, fieldName: 'La Barrida', activeCrop: null }],
      fields: [{ id: 1, name: 'La Barrida' }],
      corrals: [],
      crops: ['soja', 'maíz'],
      lists: {
        plots: [{ id: '7', title: 'Norte (La Barrida)' }],
        crops: [{ id: 'soja', title: 'soja' }, { id: 'maíz', title: 'maíz' }],
      },
    });
    const items: unknown[] = [];
    await appendFormOffer(items as never, {
      messages: [], sideEffects: { offerForm: { action: 'sow_crop', prefill: {} } },
    } as never, waCtx);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'whatsapp', action: 'sow_crop',
    }));
    expect(items).toHaveLength(1);
    const item = items[0] as { interactive: { type: string; flow: { flowId: string; flowToken: string; mode?: string; data: Record<string, unknown> } } };
    expect(item.interactive.type).toBe('flow');
    expect(item.interactive.flow.flowId).toBe('flow_sow_123');
    expect(item.interactive.flow.flowToken).toBe('tok123');
    // WHATSAPP_FLOW_MODE no seteado → default draft → la clave `mode` viaja.
    expect(item.interactive.flow.mode).toBe('draft');
    expect(item.interactive.flow.data.plot_id_options).toEqual([{ id: '7', title: 'Norte (La Barrida)' }]);
    expect(item.interactive.flow.data.crop_options).toEqual([{ id: 'soja', title: 'soja' }, { id: 'maíz', title: 'maíz' }]);
    // Todo lo declarado en el esquema del screen viaja, incluso vacío (Flows lo exige).
    expect(item.interactive.flow.data.crop_other_init).toBe('');
    expect(item.interactive.flow.data.plot_id_init).toBe('7'); // único lote → prellenado
  });

  // --- Alta de hacienda: mode draft/published + las 11 claves + gap B ---

  const livestockOffer = {
    messages: [], sideEffects: { offerForm: { action: 'add_livestock', prefill: {} } },
  };
  const livestockOpts = (locations: Array<{ id: string; title: string }>) => ({
    plots: [], fields: [], corrals: [], crops: [],
    lists: {
      livestock_categories: [{ id: 'novillo', title: 'Novillo' }, { id: 'vaca', title: 'Vaca' }],
      breeds: [{ id: 'angus', title: 'Angus' }],
      livestock_locations: locations,
    },
  });

  it('hacienda: mode=published omite la clave `mode` (Meta rechaza "published") y hornea las 11 claves', async () => {
    getSettingMock.mockImplementation(async (k: string) =>
      k === 'WHATSAPP_FORM_PROVIDER' ? 'meta_flow' : k === 'WHATSAPP_FLOW_ID_LIVESTOCK' ? 'flow_liv_1' : k === 'WHATSAPP_FLOW_MODE' ? 'published' : null);
    computeOptsMock.mockResolvedValue(livestockOpts([{ id: 'p:1', title: 'Lote 1' }]));
    const items: unknown[] = [];
    await appendFormOffer(items as never, livestockOffer as never, waCtx);
    expect(items).toHaveLength(1);
    const flow = (items[0] as { interactive: { flow: { mode?: string; data: Record<string, unknown> } } }).interactive.flow;
    expect('mode' in flow).toBe(false); // clave AUSENTE, no vacía
    expect(Object.keys(flow.data).sort()).toEqual([
      'breed_init', 'breed_options', 'category_init', 'category_options',
      'count_init', 'currency_init', 'event_date_init', 'location_init',
      'location_options', 'notes_init', 'unit_price_init',
    ]);
    // currency_init viaja vacío (Dropdown sin preseleccionar); el default ARS lo
    // pone el casteo al enviar, no el prellenado. event_date sí se prellena hoy.
    expect(flow.data.currency_init).toBe('');
    expect(String(flow.data.event_date_init)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('hacienda: mode=draft incluye "mode":"draft"', async () => {
    getSettingMock.mockImplementation(async (k: string) =>
      k === 'WHATSAPP_FORM_PROVIDER' ? 'meta_flow' : k === 'WHATSAPP_FLOW_ID_LIVESTOCK' ? 'flow_liv_1' : k === 'WHATSAPP_FLOW_MODE' ? 'draft' : null);
    computeOptsMock.mockResolvedValue(livestockOpts([{ id: 'p:1', title: 'Lote 1' }]));
    const items: unknown[] = [];
    await appendFormOffer(items as never, livestockOffer as never, waCtx);
    const flow = (items[0] as { interactive: { flow: { mode?: string } } }).interactive.flow;
    expect(flow.mode).toBe('draft');
  });

  it('gap B: un select REQUERIDO sin opciones (location vacío) no manda el Flow', async () => {
    getSettingMock.mockImplementation(async (k: string) =>
      k === 'WHATSAPP_FORM_PROVIDER' ? 'meta_flow' : k === 'WHATSAPP_FLOW_ID_LIVESTOCK' ? 'flow_liv_1' : k === 'WHATSAPP_FLOW_MODE' ? 'draft' : null);
    computeOptsMock.mockResolvedValue(livestockOpts([])); // sin lotes ni corrales
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const items: unknown[] = [];
    await appendFormOffer(items as never, livestockOffer as never, waCtx);
    expect(items).toHaveLength(0);
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('opciones vacías') && String(c[0]).includes('location'))).toBe(true);
    errSpy.mockRestore();
  });

  it('en whatsapp una oferta IMPLÍCITA no abre un segundo colector (el handler ya pregunta)', async () => {
    getSettingMock.mockResolvedValue(null);
    const items: unknown[] = [];
    await appendFormOffer(items as never, {
      messages: [], sideEffects: { offerForm: { action: 'sow_crop', prefill: {} } },
    } as never, waCtx);
    expect(items).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
    expect(startConvMock).not.toHaveBeenCalled();
  });

  it('whatsapp + provider conversation (default) + pedido explícito → formulario por chat, sin Flow', async () => {
    getSettingMock.mockImplementation(async (k: string) => (k === 'WHATSAPP_FLOW_ID_EXPENSE' ? 'flow_x' : null));
    const items: unknown[] = [];
    await appendFormOffer(items as never, {
      messages: [], sideEffects: { offerForm: { action: 'log_expense', prefill: { amount: 250000 }, explicit: true } },
    } as never, waCtx);
    expect(startConvMock).toHaveBeenCalledWith(waCtx, { action: 'log_expense', prefill: { amount: 250000 } });
    expect(createMock).not.toHaveBeenCalled(); // ninguna sesión de Flow
    expect(items).toEqual([{ type: 'text', text: '💰 ¿Cuánto gastaste?' }]);
  });

  it('provider meta_flow SIN flow_id → cae a conversation (nunca un formulario que no abre)', async () => {
    getSettingMock.mockImplementation(async (k: string) => (k === 'WHATSAPP_FORM_PROVIDER' ? 'meta_flow' : ''));
    const items: unknown[] = [];
    await appendFormOffer(items as never, {
      messages: [], sideEffects: { offerForm: { action: 'sow_crop', prefill: {}, explicit: true } },
    } as never, waCtx);
    expect(startConvMock).toHaveBeenCalledTimes(1);
    expect(items.some(i => (i as { interactive?: { type?: string } }).interactive?.type === 'flow')).toBe(false);
  });

  it('resumeForm → retoma el formulario conversacional', async () => {
    const items: unknown[] = [];
    await appendFormOffer(items as never, {
      messages: [], sideEffects: { resumeForm: { action: 'log_expense' } },
    } as never, waCtx);
    expect(resumeConvMock).toHaveBeenCalledWith(waCtx, 'log_expense');
    expect(items).toEqual([{ type: 'text', text: '↩️ Sigamos' }]);
  });
});
