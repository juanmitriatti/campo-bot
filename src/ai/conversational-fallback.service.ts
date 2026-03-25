import Anthropic from '@anthropic-ai/sdk';
import { getSetting, getSettingNumber, getSettingBool } from '../services/settings.service.js';
import { saveAiFallbackLog } from '../services/expenses.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { logError } from '../services/error-logger.js';
import type { UserId, UserSettings, AiUsage } from '../types/index.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT =
  'Sos un asistente agrícola en un bot de WhatsApp para productores argentinos. ' +
  'Respondé brevemente en español (máximo 2 oraciones). ' +
  'Si la pregunta es sobre agricultura, cultivos, lluvia o campo, dá una respuesta útil y corta. ' +
  'Si preguntan qué puede hacer el bot, explicá brevemente: registrar gastos, ingresos, lluvias, actividades agrícolas y pedir reportes. ' +
  'Nunca inventes datos del campo del usuario. Hablá en general.';

// Defaults — overridden by system_settings at runtime
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_OUTPUT_TOKENS = 120;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_RATE_LIMIT_MAX = 5;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const RATE_LIMIT_RESPONSE =
  'Podés registrar gastos, lluvias, actividades o pedir reportes de tus campos. ' +
  'Probá por ejemplo: "reporte campo norte" o "gasté 50mil en gasoil".';

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitMap = new Map<number, RateLimitEntry>();

function isRateLimited(userId: number, maxCalls: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry) return false;

  entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
  return entry.timestamps.length >= maxCalls;
}

function recordUsage(userId: number, windowMs: number): void {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (entry) {
    entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
    entry.timestamps.push(now);
  } else {
    rateLimitMap.set(userId, { timestamps: [now] });
  }
}

export interface FallbackResult {
  response: string;
  aiUsed: boolean;
  rateLimited: boolean;
  usage?: AiUsage;
}

export class ConversationalFallbackService {
  private userRepo: UserRepository;

  constructor(userRepo?: UserRepository) {
    this.userRepo = userRepo ?? new UserRepository();
  }

  async respond(
    text: string,
    userId: UserId,
    settings: UserSettings,
  ): Promise<FallbackResult> {
    // Kill switch
    const enabled = await getSettingBool('CONVERSATIONAL_FALLBACK_ENABLED');
    if (enabled === false) {
      return { response: RATE_LIMIT_RESPONSE, aiUsed: false, rateLimited: false };
    }

    // Load rate limit settings from DB (cached 5 min)
    const rateLimitMax = (await getSettingNumber('CONVERSATIONAL_FALLBACK_RATE_LIMIT_MAX')) ?? DEFAULT_RATE_LIMIT_MAX;
    const rateLimitWindow = (await getSettingNumber('CONVERSATIONAL_FALLBACK_RATE_LIMIT_WINDOW_MS')) ?? DEFAULT_RATE_LIMIT_WINDOW_MS;

    // Rate limit check
    if (isRateLimited(userId, rateLimitMax, rateLimitWindow)) {
      return { response: RATE_LIMIT_RESPONSE, aiUsed: false, rateLimited: true };
    }

    // Daily AI limit check (shared with intent extractor)
    const claudeLimit = settings.claude_daily_limit || 50;
    const dailyCount = await this.userRepo.getDailyClaudeCount(userId);
    if (dailyCount >= claudeLimit) {
      return { response: RATE_LIMIT_RESPONSE, aiUsed: false, rateLimited: true };
    }

    try {
      // Load model settings from DB (cached 5 min)
      const [model, maxTokens, timeoutMs, temperature, systemPrompt] = await Promise.all([
        getSetting('CONVERSATIONAL_FALLBACK_MODEL'),
        getSettingNumber('CONVERSATIONAL_FALLBACK_MAX_TOKENS'),
        getSettingNumber('CONVERSATIONAL_FALLBACK_TIMEOUT_MS'),
        getSettingNumber('CONVERSATIONAL_FALLBACK_TEMPERATURE'),
        getSetting('CONVERSATIONAL_FALLBACK_SYSTEM_PROMPT'),
      ]);

      const resolvedModel = model || DEFAULT_MODEL;
      const resolvedMaxTokens = maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const resolvedTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const resolvedTemperature = temperature ?? DEFAULT_TEMPERATURE;
      const resolvedSystemPrompt = systemPrompt || SYSTEM_PROMPT;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), resolvedTimeout);

      let apiResponse: Anthropic.Message;
      try {
        apiResponse = await anthropic.messages.create(
          {
            model: resolvedModel,
            max_tokens: resolvedMaxTokens,
            temperature: resolvedTemperature,
            system: resolvedSystemPrompt,
            messages: [{ role: 'user', content: text }],
          },
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      const usage: AiUsage = {
        input_tokens: apiResponse.usage.input_tokens,
        output_tokens: apiResponse.usage.output_tokens,
      };

      // Track usage
      await this.userRepo.saveAiUsage(userId, usage);
      saveAiFallbackLog(userId, text, { type: 'conversational_fallback' }, usage).catch(() => {});
      recordUsage(userId, rateLimitWindow);

      const responseText = apiResponse.content[0].type === 'text'
        ? apiResponse.content[0].text
        : RATE_LIMIT_RESPONSE;

      console.log(
        `CONV_FALLBACK (${dailyCount + 1}/${claudeLimit}):`,
        responseText.slice(0, 100),
        `TOKENS: ${usage.input_tokens}in/${usage.output_tokens}out`,
      );

      return { response: responseText, aiUsed: true, rateLimited: false, usage };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      if (!isTimeout) {
        logError('conv_fallback', 'FALLBACK_ERROR', err instanceof Error ? err : new Error(String(err)), {
          context: { action: 'respond', userId },
        });
      }
      console.log('CONV_FALLBACK: error —', isTimeout ? 'timeout' : (err instanceof Error ? err.message : String(err)));
      return { response: RATE_LIMIT_RESPONSE, aiUsed: false, rateLimited: false };
    }
  }

  /** Exported for testing */
  static get systemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  static get rateLimitResponse(): string {
    return RATE_LIMIT_RESPONSE;
  }

  /** Reset rate limits — for testing only */
  static resetRateLimits(): void {
    rateLimitMap.clear();
  }
}
