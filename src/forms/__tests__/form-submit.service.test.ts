// src/forms/__tests__/form-submit.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionValidate = vi.fn();
const sessionMarkUsed = vi.fn();
vi.mock('../../services/form-session.service.js', () => ({
  formSessionService: {
    validate: (...a: unknown[]) => sessionValidate(...a),
    markUsed: (...a: unknown[]) => sessionMarkUsed(...a),
  },
}));

const queryMock = vi.fn();
vi.mock('../../config/db.js', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
}));

const routeCommand = vi.fn();
const pendingGet = vi.fn();
const pendingClear = vi.fn();
vi.mock('../../services/message-pipeline.js', () => ({
  domainRouter: { routeCommand: (...a: unknown[]) => routeCommand(...a) },
  userRepository: { getSettings: vi.fn().mockResolvedValue({}) },
  pendingActStore: { get: (...a: unknown[]) => pendingGet(...a), clear: (...a: unknown[]) => pendingClear(...a) },
  hydratePendingStores: vi.fn().mockResolvedValue(undefined),
  applySideEffects: vi.fn().mockReturnValue({}),
}));
vi.mock('../../middleware/user-lock.js', () => ({
  withUserLock: (_k: string, fn: () => Promise<unknown>) => fn(),
}));
const sendTg = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/telegram.js', () => ({
  sendTelegramMessage: (...a: unknown[]) => sendTg(...a),
  sendTelegramButtons: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/whatsapp.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));
const getActiveCropMock = vi.fn();
vi.mock('../../services/expenses.js', () => ({
  getActiveCrop: (...a: unknown[]) => getActiveCropMock(...a),
}));

const { submitForm } = await import('../form-submit.service.js');

const SESSION = {
  token: 'tok', user_id: 9, action: 'sow_crop', prefill: {},
  channel: 'telegram', channel_id: '555', phone: 'tg_555',
  had_pending: false, used_at: null, expires_at: '',
};

function mockUserRow() {
  // 1ª query: SELECT users; 2ª: SELECT lote del usuario
  queryMock
    .mockResolvedValueOnce({ rows: [{ id: 9, name: 'Juan' }] })
    .mockResolvedValueOnce({ rows: [{ id: 7, name: 'Norte', field_name: 'La Esperanza' }] });
}

describe('submitForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionValidate.mockResolvedValue({ ...SESSION });
  });

  it('404 con token muerto', async () => {
    sessionValidate.mockResolvedValue(null);
    const r = await submitForm('x', {});
    expect(r).toEqual({ ok: false, status: 404, error: expect.stringContaining('venció') });
  });

  it('409 si había pending y ya no está (se resolvió por chat)', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, had_pending: true });
    pendingGet.mockReturnValue(undefined);
    mockUserRow();
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(sessionMarkUsed).toHaveBeenCalledWith('tok'); // se cierra el token
    expect(routeCommand).not.toHaveBeenCalled();
  });

  it('422 con payload inválido', async () => {
    mockUserRow();
    const r = await submitForm('tok', { plot_id: 7, event_date: '2026-08-01' }); // sin crop
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it('422 si el lote no es del usuario', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })
      .mockResolvedValueOnce({ rows: [] }); // lote no encontrado
    const r = await submitForm('tok', { plot_id: 99, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it('happy path siembra: rutea, confirma al chat, consume token y limpia pending', async () => {
    mockUserRow();
    pendingGet.mockReturnValue({ command: 'sow_crop', data: {} });
    routeCommand.mockResolvedValue({ messages: ['🌱 Siembra registrada'] });
    const r = await submitForm('tok', {
      plot_id: 7, crop: 'soja', event_date: '2026-08-01', hectares: 50, variety: 'DM 4670',
    });
    expect(r).toEqual({ ok: true, message: '🌱 Siembra registrada' });
    const cmd = routeCommand.mock.calls[0][0] as Record<string, unknown>;
    expect(cmd.command).toBe('sow_crop');
    expect(cmd.crop).toBe('soja');
    expect(cmd.plotName).toBe('Norte');
    expect(cmd.fieldName).toBe('La Esperanza');
    expect(cmd.eventDate).toBe('2026-08-01');
    expect(cmd.hectares).toBe(50);
    expect(cmd.variety).toBe('DM 4670');
    expect(sendTg).toHaveBeenCalledWith('555', '🌱 Siembra registrada');
    expect(sessionMarkUsed).toHaveBeenCalledWith('tok');
    expect(pendingClear).toHaveBeenCalledWith('tg_555');
  });

  it('cosecha toma el crop del cultivo activo y mapea loads', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'harvest_crop' });
    mockUserRow();
    getActiveCropMock.mockResolvedValue({ crop: 'maíz' });
    pendingGet.mockReturnValue(undefined);
    routeCommand.mockResolvedValue({ messages: ['🌾 Cosecha registrada'] });
    const r = await submitForm('tok', {
      plot_id: 7, event_date: '2026-08-01', humidity_pct: 14,
      loads: [{ driver_name: 'Juan', weight_kg: 28500, destinatario: 'Cargill' }],
    });
    expect(r.ok).toBe(true);
    const cmd = routeCommand.mock.calls[0][0] as Record<string, unknown>;
    expect(cmd.command).toBe('harvest_crop');
    expect(cmd.crop).toBe('maíz');
    expect(cmd.loads).toEqual([{ driver_name: 'Juan', weight_kg: 28500, destinatario: 'Cargill' }]);
  });

  it('cosecha sin cultivo activo → 422', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'harvest_crop' });
    mockUserRow();
    getActiveCropMock.mockResolvedValue(null);
    const r = await submitForm('tok', { plot_id: 7, event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cultivo activo');
  });

  it('handler que pide pending → 422 sin consumir token', async () => {
    mockUserRow();
    routeCommand.mockResolvedValue({
      messages: ['¿En qué lote?'],
      sideEffects: { setPendingActivity: { command: 'sow_crop', data: {}, missing: ['plot'] } },
    });
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    expect(sessionMarkUsed).not.toHaveBeenCalled();
  });

  it('mensaje de error del handler (❌) → 422 sin consumir token', async () => {
    mockUserRow();
    routeCommand.mockResolvedValue({ messages: ['❌ No encontré el lote'] });
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('No encontré');
    expect(sessionMarkUsed).not.toHaveBeenCalled();
  });
});
