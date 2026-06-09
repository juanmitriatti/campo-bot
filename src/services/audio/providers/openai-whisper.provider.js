import axios from 'axios';
import { getAudioConfig } from '../audio.types.js';

const MIME_TO_EXT = {
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
};

function getExtension(mimeType) {
  for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
    if (mimeType.startsWith(mime)) return ext;
  }
  return 'ogg';
}

export class OpenAIWhisperProvider {
  name = 'openai-whisper';

  async transcribe(audioBuffer, mimeType) {
    const config = getAudioConfig();
    const start = Date.now();

    const ext = getExtension(mimeType);
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), `audio.${ext}`);
    formData.append('model', config.openaiWhisperModel);
    formData.append('language', config.language);
    // Domain glossary → biases transcription toward Argentine agro/livestock
    // spelling (otherwise "desteté"→"de este", "novillos"→"navijas", etc.).
    if (config.whisperPrompt) formData.append('prompt', config.whisperPrompt);

    const response = await axios.post(
      `${config.openaiBaseUrl}/audio/transcriptions`,
      formData,
      {
        headers: { Authorization: `Bearer ${config.openaiApiKey}` },
        timeout: config.requestTimeoutMs,
      },
    );

    return {
      text: response.data.text,
      language: config.language,
      durationMs: Date.now() - start,
    };
  }
}
