import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptionService, AudioTooLongError } from '../transcription.service.js';
import type { AudioDownloadService } from '../audio-download.service.js';
import type { SpeechToTextProvider } from '../providers/speech-provider.interface.js';
import type { AudioMedia } from '../audio.types.js';

function createMockDownloadService(overrides: Partial<AudioDownloadService> = {}): AudioDownloadService {
  return {
    download: vi.fn().mockResolvedValue({
      mediaId: 'media-123',
      mimeType: 'audio/ogg',
      buffer: Buffer.from('fake-audio'),
      sizeBytes: 5000,
    } satisfies AudioMedia),
    estimateDurationSeconds: vi.fn().mockReturnValue(3),
    isAudioTooLong: vi.fn().mockReturnValue(false),
    ...overrides,
  } as unknown as AudioDownloadService;
}

function createMockProvider(overrides: Partial<SpeechToTextProvider> = {}): SpeechToTextProvider {
  return {
    name: 'mock-provider',
    transcribe: vi.fn().mockResolvedValue({
      text: 'gasté 50 mil en gasoil',
      language: 'es',
      durationMs: 150,
    }),
    ...overrides,
  };
}

describe('TranscriptionService', () => {
  let downloadService: AudioDownloadService;
  let provider: SpeechToTextProvider;
  let service: TranscriptionService;

  beforeEach(() => {
    downloadService = createMockDownloadService();
    provider = createMockProvider();
    service = new TranscriptionService(downloadService, provider);
  });

  it('processes audio through full pipeline', async () => {
    const result = await service.processAudio('media-123', 'audio/ogg');

    expect(result.transcription).toBe('gasté 50 mil en gasoil');
    expect(result.source).toBe('audio');
    expect(result.mediaId).toBe('media-123');
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);

    expect(downloadService.download).toHaveBeenCalledWith('media-123', 'audio/ogg');
    expect(provider.transcribe).toHaveBeenCalledWith(
      Buffer.from('fake-audio'),
      'audio/ogg',
    );
  });

  it('throws AudioTooLongError when audio exceeds max duration', async () => {
    downloadService = createMockDownloadService({
      isAudioTooLong: vi.fn().mockReturnValue(true) as unknown as AudioDownloadService['isAudioTooLong'],
      estimateDurationSeconds: vi.fn().mockReturnValue(180) as unknown as AudioDownloadService['estimateDurationSeconds'],
    });
    service = new TranscriptionService(downloadService, provider);

    await expect(service.processAudio('media-123', 'audio/ogg'))
      .rejects.toThrow(AudioTooLongError);
    expect(provider.transcribe).not.toHaveBeenCalled();
  });

  it('propagates download errors', async () => {
    downloadService = createMockDownloadService({
      download: vi.fn().mockRejectedValue(new Error('Network error')) as unknown as AudioDownloadService['download'],
    });
    service = new TranscriptionService(downloadService, provider);

    await expect(service.processAudio('media-123', 'audio/ogg'))
      .rejects.toThrow('Network error');
  });

  it('propagates transcription errors', async () => {
    provider = createMockProvider({
      transcribe: vi.fn().mockRejectedValue(new Error('API error')),
    });
    service = new TranscriptionService(downloadService, provider);

    await expect(service.processAudio('media-123', 'audio/ogg'))
      .rejects.toThrow('API error');
  });
});
