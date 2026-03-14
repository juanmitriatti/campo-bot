// --- Audio media from WhatsApp ---

export interface AudioMedia {
  mediaId: string;
  mimeType: string;
  buffer: Buffer;
  sizeBytes: number;
}

// --- Transcription result ---

export interface TranscriptionResult {
  text: string;
  language: string;
  durationMs: number;
}

// --- Full pipeline result ---

export interface AudioProcessingResult {
  transcription: string;
  source: 'audio';
  mediaId: string;
  processingTimeMs: number;
}

// --- Supported providers ---

export type SpeechProviderName = 'openai' | 'local_whisper' | 'google';

// --- Audio config ---

export interface AudioConfig {
  provider: SpeechProviderName;
  language: string;
  maxAudioDurationSeconds: number;
  // OpenAI / local whisper
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiWhisperModel: string;
  // Request timeout
  requestTimeoutMs: number;
}

export function getAudioConfig(): AudioConfig {
  return {
    provider: (process.env.SPEECH_PROVIDER as SpeechProviderName) || 'openai',
    language: process.env.SPEECH_LANGUAGE || 'es',
    maxAudioDurationSeconds: Number(process.env.MAX_AUDIO_DURATION_SECONDS) || 120,
    openaiApiKey: process.env.OPENAI_API_KEY || process.env.WHISPER_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || process.env.WHISPER_API_BASE_URL || 'https://api.openai.com/v1',
    openaiWhisperModel: process.env.OPENAI_AUDIO_MODEL || process.env.OPENAI_WHISPER_MODEL || process.env.WHISPER_MODEL || 'whisper-1',
    requestTimeoutMs: Number(process.env.SPEECH_TIMEOUT_MS) || 30000,
  };
}

// --- Supported audio MIME types ---

export const SUPPORTED_AUDIO_TYPES = [
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/webm',
  'audio/wav',
];

export function isSupportedAudioType(mimeType: string): boolean {
  return SUPPORTED_AUDIO_TYPES.some(t => mimeType.startsWith(t));
}
