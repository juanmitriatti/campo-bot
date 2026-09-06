// Un Flow que Meta rechaza (139000 "Blocked by Integrity" hasta verificar la
// empresa, 6 sep 2026) NO puede caer al texto: "cargá el gasto con un
// formulario" sin botón es una promesa vacía. Los demás interactivos sí caen
// al texto plano (contrato de paridad con Telegram: nunca silencio).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMessage = vi.fn(async () => {});
const sendFlow = vi.fn(async () => {});
const sendInteractiveButtons = vi.fn(async () => {});
vi.mock('../../services/whatsapp.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  sendFlow: (...a: unknown[]) => sendFlow(...a),
  sendInteractiveButtons: (...a: unknown[]) => sendInteractiveButtons(...a),
  sendInteractiveList: vi.fn(async () => {}),
  uploadMedia: vi.fn(async () => 'media'),
  sendDocument: vi.fn(async () => {}),
  downloadMedia: vi.fn(async () => Buffer.from('')),
}));
vi.mock('../../services/message-pipeline.js', () => ({
  processTextMessage: vi.fn(async () => []),
  handleInteractiveReply: vi.fn(async () => []),
  hydratePendingStores: vi.fn(async () => {}),
  userRepository: {},
  featureGate: { hasFeature: vi.fn(async () => true) },
  conversationLogger: { log: vi.fn(async () => {}) },
  pendingFieldLocationStore: { get: vi.fn(() => null), clear: vi.fn() },
  pendingDocUploadStore: { get: vi.fn(() => null), set: vi.fn(), clear: vi.fn() },
}));
vi.mock('../../services/document-pipeline.js', () => ({
  documentService: {},
  processDocumentWithIntent: vi.fn(async () => []),
  makeDocCallbackHandler: vi.fn(() => vi.fn()),
}));
vi.mock('../../services/expenses.js', () => ({ saveAudioTranscriptionLog: vi.fn(async () => {}) }));
vi.mock('../../services/settings.service.js', () => ({ getSetting: vi.fn(async () => null) }));
const logError = vi.fn(async () => {});
vi.mock('../../services/error-logger.js', () => ({ logError: (...a: unknown[]) => logError(...a) }));
vi.mock('../../services/audio/transcription.service.js', () => ({
  TranscriptionService: class {},
  AudioTooLongError: class extends Error {},
}));
vi.mock('../../domain/auth/channel-verification.service.js', () => ({
  ChannelVerificationService: class {},
  VerificationError: class VerificationError extends Error {},
}));

const { sendBotResponse } = await import('../whatsapp.controller.js');

function metaError(code: number, message: string, details: string): Error & { response: unknown } {
  const err = new Error(`Request failed with status code 400`) as Error & { response: unknown };
  err.response = { status: 400, data: { error: { code, message, error_data: { details } } } };
  return err;
}

describe('sendBotResponse (whatsapp) — Flow rechazado por Meta', () => {
  beforeEach(() => { sendMessage.mockClear(); sendFlow.mockClear(); sendInteractiveButtons.mockClear(); logError.mockClear(); });

  it('un Flow rechazado NO manda el cuerpo como texto (sería una promesa sin botón) y sigue con el resto', async () => {
    sendFlow.mockRejectedValueOnce(metaError(139000, '(#139000) Blocked by Integrity', 'Integrity requirements not met.'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sendBotResponse('549...', [
      { type: 'text', text: '💸 ¿En qué lote lo registramos?' },
      { type: 'interactive', interactive: { type: 'flow', body: '📝 Si preferís, cargá el gasto con un formulario:', flow: { flowId: '1378034054484390', flowToken: 't', cta: 'Abrir', mode: 'draft', data: {} } } },
      { type: 'text', text: 'después' },
    ] as never);
    // El texto de la pregunta y el ítem siguiente salieron; el cuerpo del Flow, no.
    expect(sendMessage.mock.calls.map(c => c[1])).toEqual(['💸 ¿En qué lote lo registramos?', 'después']);
    // Y quedó registrado el motivo real de Meta (invariante 1).
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('139000') && String(c[0]).includes('Integrity requirements not met'))).toBe(true);
    errSpy.mockRestore();
  });

  it('un interactivo de botones que falla SÍ cae al texto plano (contrato de paridad con Telegram)', async () => {
    sendInteractiveButtons.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await sendBotResponse('549...', [
      { type: 'interactive', interactive: { type: 'buttons', body: '¿Confirmás *el gasto*?', buttons: [{ id: 'x', title: 'Sí' }] } },
    ] as never);
    expect(sendMessage).toHaveBeenCalledWith('549...', '¿Confirmás el gasto?');
    vi.restoreAllMocks();
  });
});
