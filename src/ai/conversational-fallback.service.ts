import Anthropic from '@anthropic-ai/sdk';
import { getSetting, getSettingNumber, getSettingBool } from '../services/settings.service.js';
import { saveAiFallbackLog } from '../services/expenses.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { PlanRepository } from '../domain/billing/plan.repository.js';
import { ConversationHistoryService } from './conversation-history.service.js';
import { logError } from '../services/error-logger.js';
import type { UserId, UserSettings, AiUsage } from '../types/index.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT =
  'Sos MIA, asistente de gestión agrícola por WhatsApp para productores argentinos. ' +
  'Respondé en español argentino (vos/tenés/podés), breve (máx 3-4 oraciones), tono amigable y práctico.\n\n' +
  'REGLAS:\n' +
  '- NUNCA enumeres capacidades en lista. Si el usuario pregunta qué podés hacer / cómo funcionás / para qué servís, decile en una oración que escriba *ayuda* para ver categorías con ejemplos.\n' +
  '- NUNCA digas que registraste, guardaste o anotaste algo. Vos NO podés guardar datos, solo orientar al usuario.\n' +
  '- NUNCA inventes datos del usuario (gastos, lluvias, reportes). No tenés acceso a su información.\n' +
  '- Si el usuario intenta registrar un gasto/ingreso/actividad pero le falta info, decile que repita con más contexto (ej: "gasté 50000 en gasoil en lote norte").\n' +
  '- Para consultas agro generales (plagas, fenología, fertilización), respondé en 2-3 oraciones con conocimiento general.\n' +
  '- Si no es tema agrícola/rural, sugerí escribir *menú* o *ayuda*.';

// Defaults — overridden by system_settings at runtime
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_OUTPUT_TOKENS = 500;
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
  private planRepo: PlanRepository;
  private historyService: ConversationHistoryService;

  constructor(userRepo?: UserRepository) {
    this.userRepo = userRepo ?? new UserRepository();
    this.planRepo = new PlanRepository();
    this.historyService = new ConversationHistoryService();
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

    // Daily AI limit check (plan-based, fallback to user setting)
    const claudeLimit = await this.getAiDailyLimit(userId, settings);
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

      // Historia reciente (budget chico: 1500 chars) — sin esto el fallback era
      // single-turn y las repreguntas ("¿y para la roya qué uso?") perdían todo
      // el contexto previo. Best-effort: si falla, seguimos sin historia.
      let historyTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      try {
        historyTurns = await this.historyService.getRecentTurns(userId, 1500);
      } catch {
        historyTurns = [];
      }

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
            messages: [
              ...historyTurns.map(t => ({ role: t.role, content: t.content })),
              { role: 'user', content: text },
            ],
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
      logError(
        'conv_fallback',
        isTimeout ? 'FALLBACK_TIMEOUT' : 'FALLBACK_ERROR',
        err instanceof Error ? err : new Error(String(err)),
        { context: { action: 'respond', userId } },
      );
      console.log('CONV_FALLBACK: error —', isTimeout ? 'timeout' : (err instanceof Error ? err.message : String(err)));
      return { response: RATE_LIMIT_RESPONSE, aiUsed: false, rateLimited: false };
    }
  }

  private async getAiDailyLimit(userId: UserId, settings: UserSettings): Promise<number> {
    try {
      const limit = await this.planRepo.getUserPlanAiLimit(userId);
      if (limit != null) return limit;
    } catch {
      // Plan lookup failed — use fallback
    }
    return settings.claude_daily_limit || 50;
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
