import { getAudioConfig } from '../audio.types.js';
import { OpenAIWhisperProvider } from './openai-whisper.provider.js';
import { LocalWhisperProvider } from './local-whisper.provider.js';
import { GoogleSpeechProvider } from './google.provider.js';

/**
 * Factory: create a SpeechToTextProvider based on SPEECH_PROVIDER env var.
 *
 * To add a new provider:
 * 1. Create a class implementing SpeechToTextProvider (see speech-provider.interface.ts)
 * 2. Register it here
 * 3. Add the name to SpeechProviderName in audio.types.ts
 */
export function createSpeechProvider(providerName) {
  const name = providerName ?? getAudioConfig().provider;

  switch (name) {
    case 'openai':
      return new OpenAIWhisperProvider();
    case 'local_whisper':
      return new LocalWhisperProvider();
    case 'google':
      return new GoogleSpeechProvider();
    default:
      throw new Error(`Unknown speech provider: "${name}". Valid: openai, local_whisper, google`);
  }
}
