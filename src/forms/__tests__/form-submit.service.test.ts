// src/forms/__tests__/form-submit.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionValidate = vi.fn();
const sessionMarkUsed = vi.fn();
const sessionClaim = vi.fn();
const sessionFind = vi.fn();
vi.mock('../../services/form-session.service.js', () => ({
  formSessionService: {
    validate: (...a: unknown[]) => sessionValidate(...a),
    markUsed: (...a: unknown[]) => sessionMarkUsed(...a),
    claim: (...a: unknown[]) => sessionClaim(...a),
    find: (...a: unknown[]) => sessionFind(...a),
  },
}));

const queryMock = vi.fn();
vi.mock('../../config/db.js', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
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
const accessMode = vi.fn();
vi.mock('../../services/access-gate.service.js', () => ({
  getUserAccessMode: (...a: unknown[]) => accessMode(...a),
  trialExpiredCopy: vi.fn().mockResolvedValue('⏳ Tu prueba gratis terminó.'),
}));
const lockKeys: string[] = [];
vi.mock('../../middleware/user-lock.js', () => ({
  withUserLock: (k: string, fn: () => Promise<unknown>) => { lockKeys.push(k); return fn(); },
}));
const sendTg = vi.fn().mockResolvedValue(undefined);
const sendTgButtons = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/telegram.js', () => ({
  sendTelegramMessage: (...a: unknown[]) => sendTg(...a),
  sendTelegramButtons: (...a: unknown[]) => sendTgButtons(...a),
  sendTelegramList: vi.fn().mockResolvedValue(undefined),
}));
const findSimilarMock = vi.fn();
vi.mock('../../domain/financial/category.service.js', () => ({
  CategoryService: class { findSimilar(...a: unknown[]) { return findSimilarMock(...a); } },
}));
vi.mock('../../domain/financial/category.repository.js', () => ({ CategoryRepository: class {} }));
vi.mock('../../services/whatsapp.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));
const getActiveCropMock = vi.fn();
vi.mock('../../services/expenses.js', () => ({
  getActiveCrop: (...a: unknown[]) => getActiveCropMock(...a),
}));
const computeOptsMock = vi.fn();
vi.mock('../form-options.js', async () => {
  const actual = await vi.importActual<typeof import('../form-options.js')>('../form-options.js');
  return { ...actual, computeFormOptions: (...a: unknown[]) => computeOptsMock(...a) };
});

const { submitForm, lockKeyForSession, DUPLICATE_SUBMIT_MESSAGE } = await import('../form-submit.service.js');

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
    lockKeys.length = 0;
    sessionValidate.mockResolvedValue({ ...SESSION });
    sessionClaim.mockResolvedValue({ ...SESSION });
    sessionFind.mockResolvedValue(null);
    // clearAllMocks no borra implementaciones: sin esto el "maíz activo" de un
    // test de cosecha se colaba en los de siembra (que ahora miran el lote).
    getActiveCropMock.mockReset();
    getActiveCropMock.mockResolvedValue(null);
    findSimilarMock.mockReset();
    findSimilarMock.mockResolvedValue(null);
    accessMode.mockResolvedValue('full');
  });

  // Alta de hacienda: el handler confirma SOLO con botones (messages: []). La
  // pantalla web recibía message:'' y no mostraba nada, y los botones no
  // llegaban al chat.
  it('handler que confirma solo con botones: el mensaje es el cuerpo y los botones van al chat', async () => {
    mockUserRow();
    const interactive = { type: 'buttons' as const, body: '🐄 Hacienda registrada', buttons: [{ id: 'lv_stock', title: 'Ver stock' }] };
    routeCommand.mockResolvedValue({ messages: [], interactive });
    queryMock.mockImplementation(async (sql: string) => (
      String(sql).includes('pg_stat_xact_user_tables') ? { rows: [{ relname: 'plot_crops' }] } : { rows: [{ id: 9, name: 'Norte', field_name: 'La Esperanza' }] }
    ));
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r).toMatchObject({ ok: true, message: '🐄 Hacienda registrada' });
    expect(sendTgButtons).toHaveBeenCalledWith('555', '🐄 Hacienda registrada', interactive.buttons);
    expect(sendTg).not.toHaveBeenCalled(); // sin texto vacío al chat
  });

  it('form web: categoría "Otro…" parecida a una existente → usa la existente; si no hay, la crea sin re-preguntar', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'log_expense' });
    computeOptsMock.mockResolvedValue({ plots: [{ id: 7 }], fields: [{ id: 3, name: 'La Esperanza' }], corrals: [], crops: [], lists: {} });
    queryMock.mockImplementation(async (sql: string) => (
      String(sql).includes('pg_stat_xact_user_tables') ? { rows: [{ relname: 'expenses' }] } : { rows: [{ id: 9 }] }
    ));
    routeCommand.mockResolvedValue({ messages: ['✅ Gasto registrado'] });

    findSimilarMock.mockResolvedValueOnce({ id: 4, name: 'Sueldos' });
    await submitForm('tok', { amount: 1000, currency: 'ARS', category_other: 'Sueldo', event_date: '2026-08-01' });
    expect(routeCommand.mock.calls[0][0]).toMatchObject({ category: 'Sueldos', category_match: 'exact' });

    await submitForm('tok', { amount: 1000, currency: 'ARS', category_other: 'Veterinaria', event_date: '2026-08-01' });
    expect(routeCommand.mock.calls[1][0]).toMatchObject({ category: 'Veterinaria', category_match: 'new', categoryConfirmedNew: true });

    // El colector ya preguntó: no se vuelve a buscar una parecida.
    findSimilarMock.mockClear();
    await submitForm('tok', { amount: 1000, currency: 'ARS', category_other: 'Sueldo', category_other_confirmed: true, event_date: '2026-08-01' });
    expect(findSimilarMock).not.toHaveBeenCalled();
    expect(routeCommand.mock.calls[2][0]).toMatchObject({ category: 'Sueldo', category_match: 'new' });
  });

  it('siembra sobre un lote con OTRO cultivo activo, sin confirmación (form web / Flow) → 422 claro y no escribe', async () => {
    mockUserRow();
    getActiveCropMock.mockResolvedValue({ crop: 'maíz' });
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.field).toBe('plot_id');
      expect(r.error).toMatch(/ya tiene maíz activo/);
    }
    expect(routeCommand).not.toHaveBeenCalled();
  });

  it('con la confirmación del reemplazo (colector) el comando lleva __forceReplaceCampaign', async () => {
    mockUserRow();
    getActiveCropMock.mockResolvedValue({ crop: 'maíz' });
    routeCommand.mockResolvedValue({ messages: ['🌱 Siembra registrada'] });
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01', replace_active_crop: 'maíz' });
    expect(r.ok).toBe(true);
    expect(routeCommand.mock.calls[0][0]).toMatchObject({ command: 'sow_crop', __forceReplaceCampaign: true });
  });

  it('404 con token muerto', async () => {
    sessionValidate.mockResolvedValue(null);
    const r = await submitForm('x', {});
    expect(r).toEqual({ ok: false, status: 404, error: expect.stringContaining('venció') });
  });

  it('token ya usado (submit repetido) → 409 "ya quedó registrado", sin escribir', async () => {
    sessionValidate.mockResolvedValue(null);
    sessionFind.mockResolvedValue({ ...SESSION, used_at: '2026-09-28T10:00:00Z', status: null });
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r).toEqual({ ok: false, status: 409, error: DUPLICATE_SUBMIT_MESSAGE });
    expect(routeCommand).not.toHaveBeenCalled();
  });

  it('409 si había pending y ya no está (se resolvió por chat)', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, had_pending: true });
    pendingGet.mockReturnValue(undefined);
    queryMock.mockResolvedValueOnce({ rows: [{ id: 9, name: 'Juan' }] });
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(sessionClaim).toHaveBeenCalledWith('tok'); // se cierra el token
    expect(routeCommand).not.toHaveBeenCalled();
  });

  it('422 con payload inválido', async () => {
    mockUserRow();
    const r = await submitForm('tok', { plot_id: 7, event_date: '2026-08-01' }); // sin crop
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
    expect(sessionClaim).not.toHaveBeenCalled();
  });

  it('422 si el lote no es del usuario', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })
      .mockResolvedValueOnce({ rows: [] }); // lote no encontrado
    const r = await submitForm('tok', { plot_id: 99, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(422); expect(r.field).toBe('plot_id'); }
    expect(routeCommand).not.toHaveBeenCalled();
  });

  it('el ownership usa la fuente única de acceso (dueño + miembros de campo compartido)', async () => {
    mockUserRow();
    routeCommand.mockResolvedValue({ messages: ['🌱 Siembra registrada'] });
    await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    const plotSql = String(queryMock.mock.calls[1][0]);
    expect(plotSql).toContain('field_members');
    expect(queryMock.mock.calls[1][1]).toEqual([7, 9]);
  });

  it('id manipulado (no numérico) no llega a la DB', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 9 }] });
    const r = await submitForm('tok', { plot_id: '7 OR 1=1', crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1); // solo el SELECT users
  });

  it('ubicación manipulada (lote de otro usuario) en un gasto → 422 location', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'log_expense' });
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })
      .mockResolvedValueOnce({ rows: [] }); // p:999 no accesible
    const r = await submitForm('tok', {
      amount: 1000, currency: 'ARS', category: 'Combustible', location: 'p:999', event_date: '2026-08-01',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(422); expect(r.field).toBe('location'); }
    expect(routeCommand).not.toHaveBeenCalled();
  });

  it('select dinámico fuera de la lista del usuario (hacienda) → 422', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'add_livestock' });
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'Norte', field_name: 'La Esperanza' }] });
    computeOptsMock.mockResolvedValue({
      plots: [], fields: [], corrals: [], crops: [],
      lists: { livestock_categories: [{ id: 'vaca', title: 'Vaca' }], breeds: [{ id: 'Angus', title: 'Angus' }] },
    });
    const r = await submitForm('tok', {
      category: 'DROP TABLE', count: 10, location: 'p:7', event_date: '2026-08-01',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(422); expect(r.field).toBe('category'); }
    expect(routeCommand).not.toHaveBeenCalled();
  });

  // Auditoría oct 2026 (AIS-20): el submit entraba por routeCommand sin pasar
  // por el gate del bot, y con la prueba vencida el formulario seguía guardando.
  it('prueba vencida → 403 con el mensaje de plan, sin rutear ni quemar el token', async () => {
    mockUserRow();
    pendingGet.mockReturnValue({ command: 'sow_crop', data: {} });
    accessMode.mockResolvedValue('trial_expired_readonly');
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toMatch(/prueba gratis terminó/);
    }
    expect(routeCommand).not.toHaveBeenCalled();
    expect(sessionClaim).not.toHaveBeenCalled();
    // Cortó antes de las consultas: que sus respuestas encoladas no se cuelen en el test siguiente.
    queryMock.mockReset();
  });

  it('happy path siembra: rutea, confirma al chat, reclama el token y limpia pending', async () => {
    mockUserRow();
    pendingGet.mockReturnValue({ command: 'sow_crop', data: {} });
    routeCommand.mockResolvedValue({ messages: ['🌱 Siembra registrada'] });
    const r = await submitForm('tok', {
      plot_id: 7, crop: 'soja', event_date: '2026-08-01', hectares: 50, variety: 'DM 4670',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('🌱 Siembra registrada');
    const cmd = routeCommand.mock.calls[0][0] as Record<string, unknown>;
    expect(cmd.command).toBe('sow_crop');
    expect(cmd.crop).toBe('soja');
    expect(cmd.plotName).toBe('Norte');
    expect(cmd.fieldName).toBe('La Esperanza');
    expect(cmd.eventDate).toBe('2026-08-01');
    expect(cmd.hectares).toBe(50);
    expect(cmd.variety).toBe('DM 4670');
    expect(sendTg).toHaveBeenCalledWith('555', '🌱 Siembra registrada');
    expect(sessionClaim).toHaveBeenCalledWith('tok');
    expect(pendingClear).toHaveBeenCalledWith('tg_555');
    // Mismo lock que el controller de Telegram (antes: session.phone a secas).
    expect(lockKeys).toEqual(['tg:555']);
  });

  it('submit duplicado concurrente: el segundo no reclama el token y NO escribe', async () => {
    let claimed = false;
    sessionClaim.mockImplementation(async () => {
      if (claimed) return null;
      claimed = true;
      return { ...SESSION };
    });
    sessionFind.mockResolvedValue({ ...SESSION, used_at: '2026-09-28T10:00:00Z' });
    queryMock.mockImplementation(async (sql: string) => (
      String(sql).includes('FROM users')
        ? { rows: [{ id: 9 }] }
        : { rows: [{ id: 7, name: 'Norte', field_name: 'La Esperanza' }] }
    ));
    routeCommand.mockResolvedValue({ messages: ['🌱 Siembra registrada'] });
    const payload = { plot_id: 7, crop: 'soja', event_date: '2026-08-01' };
    const [a, b] = await Promise.all([submitForm('tok', payload), submitForm('tok', payload)]);
    expect(routeCommand).toHaveBeenCalledTimes(1);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const dup = a.ok ? b : a;
    if (!dup.ok) expect(dup.status).toBe(409);
  });

  it('token de otro usuario (userId distinto) → 404 sin revelar nada', async () => {
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' }, { userId: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
    expect(routeCommand).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('deliver:return + alreadyLocked: no empuja al chat ni toma el lock, devuelve la respuesta', async () => {
    mockUserRow();
    const response = { messages: ['🌱 Siembra registrada'], interactive: { type: 'buttons', body: 'x', buttons: [] } };
    routeCommand.mockResolvedValue(response);
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' },
      { deliver: 'return', alreadyLocked: true, userId: 9 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.response).toBe(response);
    expect(sendTg).not.toHaveBeenCalled();
    expect(lockKeys).toEqual([]);
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

  it('nfm_reply de WhatsApp (flowResponse): re-arma loads desde los slots y mapea strings a números', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'harvest_crop', channel: 'whatsapp' });
    mockUserRow();
    getActiveCropMock.mockResolvedValue({ crop: 'maíz' });
    pendingGet.mockReturnValue(undefined);
    routeCommand.mockResolvedValue({ messages: ['🌾 Cosecha registrada'] });
    // Exactamente lo que llega en response_json: todo string, slots vacíos incluidos, flow_token adentro.
    const r = await submitForm('tok', {
      flow_token: 'tok',
      plot_id: '7', event_date: '2026-08-01', yield_kg_per_ha: '', yield_kg: '', humidity_pct: '14',
      loads_1_driver_name: 'Juan', loads_1_weight_kg: '28500', loads_1_destinatario: 'Cargill', loads_1_humidity_pct: '',
      loads_2_driver_name: '', loads_2_weight_kg: '', loads_2_destinatario: '', loads_2_humidity_pct: '',
      loads_3_driver_name: 'Pedro', loads_3_weight_kg: '30000', loads_3_destinatario: '', loads_3_humidity_pct: '',
      loads_4_driver_name: '', loads_4_weight_kg: '', loads_5_driver_name: '', loads_5_weight_kg: '',
    }, { flowResponse: true, alreadyLocked: true });
    expect(r.ok).toBe(true);
    const cmd = routeCommand.mock.calls[0][0] as Record<string, unknown>;
    expect(cmd.command).toBe('harvest_crop');
    expect(cmd.humidity_pct).toBe(14);
    expect(cmd.loads).toEqual([
      { driver_name: 'Juan', weight_kg: 28500, destinatario: 'Cargill' },
      { driver_name: 'Pedro', weight_kg: 30000 },
    ]);
  });

  it('nfm_reply duplicado (Meta reintenta): el segundo no escribe', async () => {
    sessionValidate.mockResolvedValueOnce({ ...SESSION, action: 'sow_crop', channel: 'whatsapp' }).mockResolvedValueOnce(null);
    sessionFind.mockResolvedValue({ ...SESSION, used_at: '2026-09-28T10:00:00Z' });
    mockUserRow();
    routeCommand.mockResolvedValue({ messages: ['🌱 Siembra registrada'] });
    const payload = { flow_token: 'tok', plot_id: '7', crop: 'soja', event_date: '2026-08-01' };
    const first = await submitForm('tok', payload, { flowResponse: true, alreadyLocked: true });
    const second = await submitForm('tok', payload, { flowResponse: true, alreadyLocked: true });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, status: 409, error: DUPLICATE_SUBMIT_MESSAGE });
    expect(routeCommand).toHaveBeenCalledTimes(1);
  });

  it('cosecha sin cultivo activo → 422', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'harvest_crop' });
    mockUserRow();
    getActiveCropMock.mockResolvedValue(null);
    const r = await submitForm('tok', { plot_id: 7, event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cultivo activo');
  });

  it('handler que pide pending → 422 (rollback: el token queda libre para reintentar)', async () => {
    mockUserRow();
    routeCommand.mockResolvedValue({
      messages: ['¿En qué lote?'],
      sideEffects: { setPendingActivity: { command: 'sow_crop', data: {}, missing: ['plot'] } },
    });
    const r = await submitForm('tok', { plot_id: 7, crop: 'soja', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
    expect(sessionMarkUsed).not.toHaveBeenCalled();
  });

  it('handler que CONTESTA con una pregunta (picker) sin escribir → 422 con el campo a re-preguntar', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'log_expense' });
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM users')) return { rows: [{ id: 9 }] };
      if (String(sql).includes('pg_stat_xact_user_tables')) return { rows: [] }; // no se escribió expenses
      return { rows: [] };
    });
    routeCommand.mockResolvedValue({
      // El tip engine pegaba un tip y el submit lo contaba como éxito.
      messages: ['💡 También podés mandarme un audio'],
      interactive: { type: 'list', body: '¿En qué categoría va este gasto de $250.000?', buttonText: 'Elegir', sections: [{ title: 'x', rows: [{ id: 'cat_pick_exp_ab_1', title: 'Combustible' }] }] },
    });
    const r = await submitForm('tok', { amount: 250000, currency: 'ARS', category: 'Combustible', event_date: '2026-08-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.field).toBe('category');
      expect(r.error).toMatch(/categoría/);
    }
  });

  it('gasto con categoría escrita a mano ("Otro…") pide crearla; elegida de la lista, match exacto', async () => {
    sessionValidate.mockResolvedValue({ ...SESSION, action: 'log_expense' });
    queryMock.mockImplementation(async (sql: string) => (
      String(sql).includes('pg_stat_xact_user_tables') ? { rows: [{ relname: 'expenses' }] } : { rows: [{ id: 9 }] }
    ));
    routeCommand.mockResolvedValue({ messages: ['✅ Gasto registrado'] });
    await submitForm('tok', { amount: 1000, currency: 'ARS', category: '__other__', category_other: 'Flete', event_date: '2026-08-01' });
    expect((routeCommand.mock.calls[0][0] as Record<string, unknown>).category_match).toBe('new');
    await submitForm('tok', { amount: 1000, currency: 'ARS', category: 'Combustible', event_date: '2026-08-01' });
    expect((routeCommand.mock.calls[1][0] as Record<string, unknown>).category_match).toBe('exact');
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

describe('lockKeyForSession', () => {
  it('usa la misma clave que cada controller', () => {
    expect(lockKeyForSession({ channel: 'whatsapp', channel_id: '549341', phone: '549341' })).toBe('wa:549341');
    expect(lockKeyForSession({ channel: 'telegram', channel_id: '555', phone: 'tg_555' })).toBe('tg:555');
    expect(lockKeyForSession({ channel: 'testbot', channel_id: 'testbot_9', phone: 'testbot_9' })).toBe('tb:testbot_9');
  });
});
