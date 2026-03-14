// Audio config — see audio.types.ts for TypeScript definitions
import { getSetting } from '../settings.service.js';

export const SUPPORTED_AUDIO_TYPES = [
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/webm',
  'audio/wav',
];

export function isSupportedAudioType(mimeType) {
  return SUPPORTED_AUDIO_TYPES.some(t => mimeType.startsWith(t));
}

/**
 * Synchronous config using process.env only (for non-async contexts).
 */
export function getAudioConfig() {
  return {
    provider: process.env.SPEECH_PROVIDER || 'openai',
    language: process.env.SPEECH_LANGUAGE || 'es',
    maxAudioDurationSeconds: Number(process.env.MAX_AUDIO_DURATION_SECONDS) || 120,
    openaiApiKey: process.env.OPENAI_API_KEY || process.env.WHISPER_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || process.env.WHISPER_API_BASE_URL || 'https://api.openai.com/v1',
    openaiWhisperModel: process.env.OPENAI_WHISPER_MODEL || process.env.WHISPER_MODEL || 'whisper-1',
    requestTimeoutMs: Number(process.env.SPEECH_TIMEOUT_MS) || 30000,
  };
}

/**
 * Async config that checks DB settings first, then falls back to env.
 */
export async function getAudioConfigAsync() {
  const [maxDuration, whisperModel, timeoutMs] = await Promise.all([
    getSetting('MAX_AUDIO_DURATION_SECONDS'),
    getSetting('OPENAI_WHISPER_MODEL'),
    getSetting('SPEECH_TIMEOUT_MS'),
  ]);
  return {
    provider: process.env.SPEECH_PROVIDER || 'openai',
    language: process.env.SPEECH_LANGUAGE || 'es',
    maxAudioDurationSeconds: Number(maxDuration) || 120,
    openaiApiKey: process.env.OPENAI_API_KEY || process.env.WHISPER_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || process.env.WHISPER_API_BASE_URL || 'https://api.openai.com/v1',
    openaiWhisperModel: whisperModel || 'whisper-1',
    requestTimeoutMs: Number(timeoutMs) || 30000,
  };
}
