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
  // Domain glossary that biases Whisper toward Argentine agro/livestock vocabulary.
  whisperPrompt: string;
  // Request timeout
  requestTimeoutMs: number;
}

/**
 * Whisper `prompt` — biases transcription toward the spelling of Argentine farm
 * vocabulary it otherwise mangles ("desteté"→"de este", "parieron"→"valieron",
 * "novillos"→"navijas", "vaquillonas"→"vaquillanas"). Whisper uses it as a style/
 * vocabulary hint. Keep < ~220 tokens. Override via WHISPER_PROMPT env.
 */
// Frases de ejemplo > lista de palabras: Whisper sesga mejor con vocabulario en
// contexto natural. "vaquillonas" suelto igual salió "vacuiciones" en vivo
// (Jun 2026) — por eso además hay un mapa determinístico de manglings conocidos
// en text-normalizer.js (STT_DOMAIN_CORRECTIONS). Capa 1: este prompt. Capa 2: el mapa.
export const DEFAULT_WHISPER_PROMPT =
  'Mensaje de un productor agropecuario argentino sobre su campo. Ejemplos: ' +
  'compré diez vaquillonas para el lote sur; las vaquillonas me salieron 500 mil por cabeza; ' +
  'vendí novillos y novillitos; desteté los terneros y las terneras; parieron las vacas; ' +
  'eché el toro, entoré, servicio, inseminé con IATF; vacuné contra aftosa y brucelosis; ' +
  'desparasité con ivermectina; pesaje, kilos promedio, cabezas, madres, hacienda, feedlot, corral; ' +
  'sembré soja, maíz, trigo, girasol, sorgo, cebada en el potrero de cien hectáreas; ' +
  'fumigué con glifosato, fertilicé con urea y fosfato, coseché y el rinde fue en quintales; ' +
  'aré, rastré, regué; cayeron veinte milímetros de lluvia; ' +
  'gasté en gasoil, nafta, agroquímicos, semillas; pesos, dólares, palos, lucas, mil.';

export function getAudioConfig(): AudioConfig {
  return {
    provider: (process.env.SPEECH_PROVIDER as SpeechProviderName) || 'openai',
    language: process.env.SPEECH_LANGUAGE || 'es',
    maxAudioDurationSeconds: Number(process.env.MAX_AUDIO_DURATION_SECONDS) || 120,
    openaiApiKey: process.env.OPENAI_API_KEY || process.env.WHISPER_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || process.env.WHISPER_API_BASE_URL || 'https://api.openai.com/v1',
    openaiWhisperModel: process.env.OPENAI_AUDIO_MODEL || process.env.OPENAI_WHISPER_MODEL || process.env.WHISPER_MODEL || 'whisper-1',
    whisperPrompt: process.env.WHISPER_PROMPT || DEFAULT_WHISPER_PROMPT,
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
