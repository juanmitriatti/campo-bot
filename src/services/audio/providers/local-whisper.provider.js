/**
 * Stub: local Whisper provider (e.g. speaches-ai/speaches Docker container).
 * Implement when local transcription is needed.
 */
export class LocalWhisperProvider {
  name = 'local-whisper';

  async transcribe(_audioBuffer, _mimeType) {
    throw new Error(
      'LocalWhisperProvider is not yet implemented. ' +
      'Set SPEECH_PROVIDER=openai or implement this provider.',
    );
  }
}
