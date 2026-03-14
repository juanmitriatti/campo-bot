import type { TranscriptionResult } from '../audio.types.js';

/**
 * Interface for speech-to-text providers.
 * Implement this to add new transcription backends
 * (e.g., local Whisper, Google Speech, Azure, etc.)
 */
export interface SpeechToTextProvider {
  readonly name: string;

  /**
   * Transcribe an audio buffer to text.
   * @param audioBuffer - Raw audio data
   * @param mimeType - MIME type of the audio (e.g., 'audio/ogg; codecs=opus')
   * @param language - BCP-47 language code (e.g., 'es')
   * @returns Transcription result with text and metadata
   */
  transcribe(audioBuffer: Buffer, mimeType: string, language: string): Promise<TranscriptionResult>;
}
