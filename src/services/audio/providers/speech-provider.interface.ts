import type { TranscriptionResult } from '../audio.types.js';

/**
 * Interface for speech-to-text providers.
 *
 * To add a new provider:
 * 1. Create a class implementing this interface
 * 2. Register it in provider-factory.js
 * 3. Add the env var key to SpeechProviderName in audio.types.ts
 */
export interface SpeechToTextProvider {
  readonly name: string;

  /**
   * Transcribe an audio buffer to text.
   * @param audioBuffer - Raw audio data (ogg, opus, mp4, mpeg, webm, wav)
   * @param mimeType - MIME type of the audio (e.g., 'audio/ogg; codecs=opus')
   * @returns Transcription result with text, detected language, and timing
   */
  transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult>;
}
