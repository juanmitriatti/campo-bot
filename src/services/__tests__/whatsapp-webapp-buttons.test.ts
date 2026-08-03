import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const axiosMock = { post: vi.fn() };
vi.mock('axios', () => ({ default: axiosMock }));
vi.mock('../error-logger.js', () => ({ logError: vi.fn() }));

describe('sendInteractiveButtons with webAppUrl (empty renderable guard)', () => {
  beforeEach(() => {
    axiosMock.post.mockResolvedValue({ status: 200 });
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id';
    process.env.WHATSAPP_TOKEN = 'test-token';
    vi.clearAllMocks();
  });
  afterEach(() => vi.clearAllMocks());

  it('skips HTTP call when all buttons have webAppUrl (0 renderable)', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const { sendInteractiveButtons } = await import('../whatsapp.js');

    await sendInteractiveButtons('+549123456789', 'Rellenar formulario', [
      { id: 'form_1', title: '📝 Formulario', webAppUrl: 'https://example.com/form/tok1' },
      { id: 'form_2', title: '✏️ Editar', webAppUrl: 'https://example.com/form/tok2' },
    ]);

    // Verify axios.post was NOT called
    expect(axiosMock.post).not.toHaveBeenCalled();

    // Verify the guard log was emitted
    expect(logSpy).toHaveBeenCalledWith('[FORM] sendInteractiveButtons: 0 botones renderizables, no se envía interactive');

    logSpy.mockRestore();
  });

  it('sends HTTP call when some buttons have no webAppUrl (>0 renderable)', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const { sendInteractiveButtons } = await import('../whatsapp.js');

    await sendInteractiveButtons('+549123456789', 'Elige una acción', [
      { id: 'regular', title: 'Opción Normal' },
      { id: 'form_1', title: '📝 Formulario', webAppUrl: 'https://example.com/form/tok1' },
    ]);

    // Verify axios.post WAS called
    expect(axiosMock.post).toHaveBeenCalledOnce();

    // Verify payload only includes the renderable button
    const payload = axiosMock.post.mock.calls[0][1];
    expect(payload.interactive.action.buttons).toHaveLength(1);
    expect(payload.interactive.action.buttons[0].reply.id).toBe('regular');
    expect(payload.interactive.action.buttons[0].reply.title).toBe('Opción Normal');

    // Verify skip log was emitted for the webAppUrl button
    expect(logSpy).toHaveBeenCalledWith('[FORM] skip web_app button (whatsapp v1):', '📝 Formulario');

    logSpy.mockRestore();
  });
});
