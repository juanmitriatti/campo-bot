/**
 * Stub: Google Cloud Speech-to-Text provider.
 * Implement when Google STT integration is needed.
 */
export class GoogleSpeechProvider {
  name = 'google-speech';

  async transcribe(_audioBuffer, _mimeType) {
    throw new Error(
      'GoogleSpeechProvider is not yet implemented. ' +
      'Set SPEECH_PROVIDER=openai or implement this provider.',
    );
  }
}
