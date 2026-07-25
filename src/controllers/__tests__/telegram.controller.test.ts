/**
 * Tests de paridad de canal (Jul 2026): los 3 gaps que Telegram tenía respecto
 * de WhatsApp — límite de audios por hora, largo máximo de audio y gate de
 * verificación en callbacks de botones. Se testea el controller entero vía HTTP
 * (puerto efímero) con los servicios de canal mockeados; la lógica de guards
 * corre real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

// --- Mocks de módulos con side-effects (DB, red) ---

vi.mock('../../services/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => {}),
  sendTelegramButtons: vi.fn(async () => {}),
  sendTelegramList: vi.fn(async () => {}),
  sendTelegramDocument: vi.fn(async () => {}),
  answerCallbackQuery: vi.fn(async () => {}),
  downloadTelegramFile: vi.fn(async () => Buffer.from('fake-audio')),
}));

vi.mock('../../services/message-pipeline.js', () => ({
  processTextMessage: vi.fn(async () => []),
  handleInteractiveReply: vi.fn(async () => [{ type: 'text', text: 'ok' }]),
  hydratePendingStores: vi.fn(async () => {}),
  userRepository: {
    findVerifiedByTelegramId: vi.fn(async () => null),
    findVerifiedByPhone: vi.fn(async () => null),
    isVerificationRequired: vi.fn(async () => false),
    getSettings: vi.fn(async () => ({})),
    getOrCreate: vi.fn(async () => ({ id: 1 })),
  },
  featureGate: { hasFeature: vi.fn(async () => true) },
  conversationLogger: { log: vi.fn(async () => {}) },
  pendingFieldLocationStore: { get: vi.fn(() => null), clear: vi.fn() },
  pendingDocUploadStore: { get: vi.fn(() => null), set: vi.fn(), clear: vi.fn() },
}));

vi.mock('../../services/document-pipeline.js', () => ({
  documentService: { checkDailyLimit: vi.fn(async () => ({ allowed: true, limit: 10 })) },
  processDocumentWithIntent: vi.fn(async () => []),
  makeDocCallbackHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../../services/expenses.js', () => ({
  getOrCreateUserByTelegramId: vi.fn(async () => ({ id: 1, phone_number: null, name: 'Test', city: null })),
  saveAudioTranscriptionLog: vi.fn(async () => {}),
  getHourlyAudioCount: vi.fn(async () => 0),
}));

vi.mock('../../services/settings.service.js', () => ({
  getSetting: vi.fn(async () => null),
  getSettingNumber: vi.fn(async () => null),
}));

vi.mock('../../services/error-logger.js', () => ({
  logError: vi.fn(async () => {}),
}));

vi.mock('../../services/access-gate.service.js', () => ({
  getUserAccessMode: vi.fn(async () => 'full'),
  trialExpiredCopy: vi.fn(async () => 'trial vencido'),
}));

vi.mock('../../services/audio/transcript-echo.js', () => ({
  buildTranscriptEcho: vi.fn(async () => null),
}));

const transcribeMock = vi.fn(async () => ({ text: 'gasté 50 mil en gasoil', durationMs: 100 }));
vi.mock('../../services/audio/providers/provider-factory.js', () => ({
  createSpeechProvider: vi.fn(() => ({ name: 'mock-stt', transcribe: transcribeMock })),
}));

vi.mock('../../domain/auth/channel-verification.service.js', () => ({
  ChannelVerificationService: class {},
  VerificationError: class VerificationError extends Error {},
}));

import telegramRouter from '../telegram.controller.js';
import { sendTelegramMessage } from '../../services/telegram.js';
import { handleInteractiveReply, userRepository, processTextMessage } from '../../services/message-pipeline.js';
import { getHourlyAudioCount, getOrCreateUserByTelegramId } from '../../services/expenses.js';
import { getSettingNumber } from '../../services/settings.service.js';

let server: Server;
let baseUrl: string;

// Los updates de Telegram se procesan async (el webhook responde 200 al toque),
// así que cada assert espera a que el efecto observable ocurra.
async function postUpdate(update: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${baseUrl}/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
  expect(res.status).toBe(200);
}

async function waitFor(fn: () => void): Promise<void> {
  await vi.waitFor(fn, { timeout: 2000, interval: 20 });
}

let nextUpdateId = 1000;
function voiceUpdate(chatId: number, durationSeconds: number) {
  return {
    update_id: nextUpdateId++,
    message: {
      chat: { id: chatId },
      from: { first_name: 'Test' },
      voice: { file_id: `voice_${nextUpdateId}`, duration: durationSeconds },
    },
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/telegram', telegramRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults sanos por test (clearAllMocks borra implementaciones de vi.fn(async...))
  vi.mocked(sendTelegramMessage).mockResolvedValue(undefined as never);
  vi.mocked(processTextMessage).mockResolvedValue([]);
  vi.mocked(handleInteractiveReply).mockResolvedValue([{ type: 'text', text: 'ok' }] as never);
  vi.mocked(userRepository.findVerifiedByTelegramId).mockResolvedValue(null as never);
  vi.mocked(userRepository.isVerificationRequired).mockResolvedValue(false as never);
  vi.mocked(userRepository.getSettings).mockResolvedValue({} as never);
  vi.mocked(getOrCreateUserByTelegramId).mockResolvedValue({ id: 1, phone_number: null, name: 'Test', city: null } as never);
  vi.mocked(getHourlyAudioCount).mockResolvedValue(0);
  vi.mocked(getSettingNumber).mockResolvedValue(null);
  transcribeMock.mockResolvedValue({ text: 'gasté 50 mil en gasoil', durationMs: 100 });
});

describe('gap 1: límite de audios por hora (paridad con WhatsApp)', () => {
  it('rechaza el audio cuando el usuario alcanzó MAX_AUDIO_PER_HOUR', async () => {
    vi.mocked(getSettingNumber).mockImplementation(async (key: string) =>
      key === 'MAX_AUDIO_PER_HOUR' ? 3 : null);
    vi.mocked(getHourlyAudioCount).mockResolvedValue(3);

    await postUpdate(voiceUpdate(9001, 10));

    await waitFor(() => {
      expect(sendTelegramMessage).toHaveBeenCalledWith(9001, expect.stringContaining('límite de 3 audios por hora'));
    });
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it('procesa el audio cuando está por debajo del límite', async () => {
    vi.mocked(getHourlyAudioCount).mockResolvedValue(1);

    await postUpdate(voiceUpdate(9002, 10));

    await waitFor(() => {
      expect(transcribeMock).toHaveBeenCalled();
    });
  });
});

describe('gap 2: largo máximo de audio (paridad con WhatsApp)', () => {
  it('rechaza el audio que excede la duración máxima sin transcribirlo', async () => {
    // default maxAudioDurationSeconds = 120 (audio.types)
    await postUpdate(voiceUpdate(9003, 600));

    await waitFor(() => {
      expect(sendTelegramMessage).toHaveBeenCalledWith(9003, expect.stringContaining('demasiado largo'));
    });
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it('transcribe un audio de duración válida', async () => {
    await postUpdate(voiceUpdate(9004, 30));

    await waitFor(() => {
      expect(transcribeMock).toHaveBeenCalled();
    });
  });
});

describe('gap 3: gate de verificación en callbacks de botones', () => {
  it('bloquea el tap de un chat NO verificado cuando la verificación es requerida', async () => {
    vi.mocked(userRepository.isVerificationRequired).mockResolvedValue(true as never);
    vi.mocked(userRepository.findVerifiedByTelegramId).mockResolvedValue(null as never);

    await postUpdate({
      update_id: nextUpdateId++,
      callback_query: {
        id: `cb_gate_${nextUpdateId}`,
        data: 'confirm_pending',
        message: { chat: { id: 9005 } },
        from: { first_name: 'Test' },
      },
    });

    await waitFor(() => {
      expect(sendTelegramMessage).toHaveBeenCalledWith(9005, expect.stringContaining('Creá tu cuenta'));
    });
    expect(handleInteractiveReply).not.toHaveBeenCalled();
    // El gate NUNCA debe auto-crear un usuario anónimo
    expect(getOrCreateUserByTelegramId).not.toHaveBeenCalled();
  });

  it('procesa el tap de un chat verificado cuando la verificación es requerida', async () => {
    vi.mocked(userRepository.isVerificationRequired).mockResolvedValue(true as never);
    vi.mocked(userRepository.findVerifiedByTelegramId).mockResolvedValue(
      { id: 7, phone_number: '549111234', name: 'Vera', city: null } as never);

    await postUpdate({
      update_id: nextUpdateId++,
      callback_query: {
        id: `cb_ok_${nextUpdateId}`,
        data: 'confirm_pending',
        message: { chat: { id: 9006 } },
        from: { first_name: 'Vera' },
      },
    });

    await waitFor(() => {
      expect(handleInteractiveReply).toHaveBeenCalledWith('confirm_pending', expect.objectContaining({ userId: 7 }));
    });
  });
});
