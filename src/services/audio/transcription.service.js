import { AudioDownloadService } from './audio-download.service.js';
import { createSpeechProvider } from './providers/provider-factory.js';
import { logError } from '../error-logger.js';

export class TranscriptionService {
  constructor(downloadService, provider) {
    this.downloadService = downloadService ?? new AudioDownloadService();
    this.provider = provider ?? createSpeechProvider();
  }

  /**
   * Full audio processing pipeline:
   * Download → validate → transcribe → return text
   */
  async processAudio(mediaId, mimeType) {
    const start = Date.now();

    try {
      // 1. Download
      console.log(`[audio] downloading media ${mediaId}`);
      const media = await this.downloadService.download(mediaId, mimeType);
      console.log(`[audio] downloaded ${media.sizeBytes} bytes`);

      // 2. Validate duration
      if (this.downloadService.isAudioTooLong(media.sizeBytes)) {
        const estimated = this.downloadService.estimateDurationSeconds(media.sizeBytes);
        throw new AudioTooLongError(estimated);
      }

      // 3. Transcribe
      console.log(`[audio] transcribing with ${this.provider.name}`);
      const result = await this.provider.transcribe(media.buffer, media.mimeType);
      console.log(`[audio] transcribed in ${result.durationMs}ms: "${result.text}"`);

      return {
        transcription: result.text,
        source: 'audio',
        mediaId,
        processingTimeMs: Date.now() - start,
        sizeBytes: media.sizeBytes,
        estimatedDurationSeconds: this.downloadService.estimateDurationSeconds(media.sizeBytes),
        providerName: this.provider.name,
        model: result.model || null,
      };
    } catch (err) {
      if (!(err instanceof AudioTooLongError)) {
        logError('audio', 'TRANSCRIPTION_ERROR', err, {
          context: { mediaId, mimeType, provider: this.provider?.name },
        });
      }
      throw err;
    }
  }
}

export class AudioTooLongError extends Error {
  constructor(estimatedSeconds) {
    super(`Audio too long: ~${estimatedSeconds}s`);
    this.name = 'AudioTooLongError';
    this.estimatedSeconds = estimatedSeconds;
  }
}
