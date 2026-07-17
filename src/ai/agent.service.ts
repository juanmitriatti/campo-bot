import Anthropic from '@anthropic-ai/sdk';
import { AgentPromptBuilder } from './agent-prompt-builder.js';
import { UserContextService } from './user-context.service.js';
import { ConversationHistoryService } from './conversation-history.service.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { PlanRepository } from '../domain/billing/plan.repository.js';
import { FewShotService } from './few-shot.service.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import { getSetting, getSettingNumber, getSettingBool } from '../services/settings.service.js';
import { saveAiFallbackLog } from '../services/expenses.js';
import { logError } from '../services/error-logger.js';
import { getActivityDictionary } from '../services/activity-dictionary.service.js';
import { limitNotifier } from '../services/limit-notifier.service.js';
import type { UserId, UserSettings, AiUsage } from '../types/index.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Reintentos explícitos ante errores transitorios (429 rate-limit, 529 overloaded,
  // 5xx) con backoff exponencial del SDK. El AbortController de extract() sigue
  // siendo el techo total — AGENT_TIMEOUT_MS debe dar margen para 1-2 reintentos.
  maxRetries: 2,
});

/**
 * Attach a cache_control marker to the last few-shot message so the
 * tools+system+few-shot prefix becomes a stable cacheable boundary.
 * Immutable — clones the last message so we don't mutate the service's output.
 */
function withFewShotCacheBoundary(
  messages: Anthropic.MessageParam[],
  cacheControl: { type: 'ephemeral'; ttl?: '5m' | '1h' },
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!Array.isArray(last.content) || last.content.length === 0) return messages;
  const newContent = [...last.content];
  const lastBlock = newContent[newContent.length - 1];
  newContent[newContent.length - 1] = {
    ...lastBlock,
    cache_control: cacheControl,
  } as typeof lastBlock;
  return [
    ...messages.slice(0, -1),
    { ...last, content: newContent },
  ];
}

export interface AgentToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}

export interface AgentResult {
  toolCalls: AgentToolCall[];
  conversationalText: string | null;
  usage: AiUsage;
  /** True when Anthropic stopped the response because max_tokens was reached. */
  truncated: boolean;
}

export class AgentService {
  private planRepo: PlanRepository;

  constructor(
    private promptBuilder: AgentPromptBuilder,
    private userContextService: UserContextService,
    private userRepo?: UserRepository,
    private historyService?: ConversationHistoryService,
    private fewShotService?: FewShotService,
  ) {
    this.planRepo = new PlanRepository();
  }

  /**
   * Extract intent(s) using Claude tool_use.
   * Returns AgentResult with tool calls (1+) or conversational text.
   * Returns null on any failure (triggers regex fallback).
   */
  async extract(
    text: string,
    _preprocessed: string,
    userId: UserId,
    settings: UserSettings,
    pendingHint: string | null = null,
  ): Promise<AgentResult | null> {
    try {
      // Check kill switch
      const enabled = await getSettingBool('AGENT_ENABLED');
      if (enabled !== true) return null;

      // Check daily rate limit (plan-based, fallback to user setting)
      const claudeLimit = await this.getAiDailyLimit(userId, settings);
      const repo = this.userRepo ?? new UserRepository();
      const dailyCount = await repo.getDailyClaudeCount(userId);
      if (dailyCount >= claudeLimit) {
        // Phase 1 — soft-block transparente. The pipeline still falls through
        // to regex (caller decides what to do), but the user gets ONE message
        // per day so the rate-limit isn't silent.
        const planName = await this.getPlanNameForLog(userId);
        void limitNotifier.maybeNotifyHit({
          userId: Number(userId),
          used: dailyCount,
          limit: claudeLimit,
          planName,
        });
        return null;
      }

      // Load user context, conversation history, few-shot examples, AND last finance query in parallel
      const historyMaxChars = (await getSettingNumber('CONVERSATION_HISTORY_MAX_CHARS')) ?? 4000;
      const fewShotLimit = (await getSettingNumber('AGENT_FEW_SHOT_LIMIT')) ?? 5;
      const lastStatePromise = (async () => {
        try {
          const { pool } = await import('../config/db.js');
          const { rows } = await pool.query('SELECT last_finance_query, last_scouting_query, last_harvest_query, last_stock_query, last_livestock_query, last_activity_query, last_rainfall_query FROM conversation_state WHERE user_id = $1', [userId]);
          return { finance: rows[0]?.last_finance_query ?? null, scouting: rows[0]?.last_scouting_query ?? null, harvest: rows[0]?.last_harvest_query ?? null, stock: rows[0]?.last_stock_query ?? null, livestock: rows[0]?.last_livestock_query ?? null, activity: rows[0]?.last_activity_query ?? null, rainfall: rows[0]?.last_rainfall_query ?? null };
        } catch { return { finance: null, scouting: null, harvest: null, stock: null, livestock: null, activity: null, rainfall: null }; }
      })();
      const [userContext, historyTurns, fewShotExamples, dictionary, lastState] = await Promise.allSettled([
        this.userContextService.loadContext(userId),
        this.historyService ? this.historyService.getRecentTurns(userId, historyMaxChars) : Promise.resolve([]),
        this.fewShotService ? this.fewShotService.getExamples(fewShotLimit) : Promise.resolve([]),
        getActivityDictionary(),
        lastStatePromise,
      ]).then(results => [
        results[0].status === 'fulfilled' ? results[0].value : null,
        results[1].status === 'fulfilled' ? results[1].value : [],
        results[2].status === 'fulfilled' ? results[2].value : [],
        results[3].status === 'fulfilled' ? results[3].value : undefined,
        results[4].status === 'fulfilled' ? results[4].value : { finance: null, scouting: null, harvest: null, stock: null, livestock: null, activity: null, rainfall: null },
      ] as const);

      // Build system prompt (stable — cacheable across users/calls).
      const botName = (await getSetting('BOT_NAME')) || 'MIA';
      const systemPrompt = this.promptBuilder.build(null, dictionary, botName);
      const reducedContext = await getSettingBool('AGENT_REDUCED_CONTEXT_PROMPT_ENABLED');
      const ls = lastState as { finance: Record<string, unknown> | null; scouting: Record<string, unknown> | null; harvest: Record<string, unknown> | null; stock: Record<string, unknown> | null; livestock: Record<string, unknown> | null; activity: Record<string, unknown> | null; rainfall: Record<string, unknown> | null };
      const userPrefix = this.promptBuilder.buildUserMessagePrefix(userContext, reducedContext, ls.finance, ls.scouting, ls.harvest, ls.stock, ls.livestock, ls.activity, ls.rainfall);

      // Load agent-specific settings
      const [model, maxTokens, timeoutMs, temperatureStr, cacheTtlSetting] = await Promise.all([
        getSetting('AGENT_MODEL'),
        getSettingNumber('AGENT_MAX_TOKENS'),
        getSettingNumber('AGENT_TIMEOUT_MS'),
        getSetting('AGENT_TEMPERATURE'),
        getSetting('AGENT_CACHE_TTL'),
      ]);

      const resolvedModel = model || 'claude-haiku-4-5-20251001';
      const resolvedMaxTokens = maxTokens || 1500;
      const resolvedTimeout = timeoutMs || 12000;
      const resolvedTemperature = temperatureStr != null ? Number(temperatureStr) : 0;
      // "short" → 5-min TTL (1.25x write), "long" → 1-hour TTL (2x write but lasts 12x longer).
      // We apply the same cache_control object to all 3 breakpoints (system, tools, few-shot).
      const cacheControl: { type: 'ephemeral'; ttl?: '5m' | '1h' } =
        cacheTtlSetting === 'long'
          ? { type: 'ephemeral', ttl: '1h' }
          : { type: 'ephemeral' };

      // Build messages: few-shot (tool_use format) + history + current.
      // Cache boundary goes on the LAST few-shot block so tools+system+few-shot
      // become a stable cacheable prefix; history varies per user/session and stays uncached.
      const fewShotPairs = this.fewShotService
        ? withFewShotCacheBoundary(this.fewShotService.formatAsToolUseMessages(fewShotExamples), cacheControl)
        : [];

      // Si hay una pregunta pendiente sin responder (pending activo), avisarle
      // al agente — sin esto, respondía sin saber que hay un slot abierto y
      // podía conflacionar el mensaje nuevo con la respuesta esperada. Va en
      // el mensaje de usuario (fuera del prefix cacheado), así no rompe cache.
      // El hint de RESCATE (escalera de escalamiento, Jul 2026) viaja completo
      // y sin el framing de "pregunta pendiente" — es una instrucción de rescate
      // con el estado del pending, no una pregunta abierta.
      const pendingLine = pendingHint
        ? (pendingHint.startsWith('RESCATE DE PENDING') || pendingHint.startsWith('ACLARACIÓN EN CURSO')
          ? `[${pendingHint}]\n`
          : `[Hay una pregunta pendiente al usuario sin responder: "${pendingHint.slice(0, 150)}". Si este mensaje NO la responde, procesalo como acción nueva.]\n`)
        : '';
      const userContent = userPrefix ? `${userPrefix}\n${pendingLine}\n${text}` : `${pendingLine}${text}`;
      const messages: Anthropic.MessageParam[] = [
        ...fewShotPairs,
        ...historyTurns.map(t => ({
          role: t.role as 'user' | 'assistant',
          content: t.content,
        })),
        { role: 'user', content: userContent },
      ];

      // Tool definitions are identical across all users → cache them.
      // Adding cache_control to the last tool marks the whole block as a cache prefix.
      const cachedTools: Anthropic.Tool[] = TOOL_DEFINITIONS.length > 0
        ? [
            ...TOOL_DEFINITIONS.slice(0, -1),
            {
              ...TOOL_DEFINITIONS[TOOL_DEFINITIONS.length - 1],
              cache_control: cacheControl,
            },
          ]
        : TOOL_DEFINITIONS;

      // Call Claude with tool_use + timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), resolvedTimeout);

      let response: Anthropic.Message;
      try {
        response = await anthropic.messages.create(
          {
            model: resolvedModel,
            max_tokens: resolvedMaxTokens,
            temperature: resolvedTemperature,
            system: [{ type: 'text', text: systemPrompt, cache_control: cacheControl }],
            tools: cachedTools,
            tool_choice: { type: 'any' },
            messages,
          },
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      // Track usage
      const cacheRead = response.usage.cache_read_input_tokens ?? 0;
      const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
      const usage: AiUsage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
      };

      await repo.saveAiUsage(userId, usage);
      saveAiFallbackLog(userId, text, { type: 'agent_tool_use' }, usage).catch(() => {});

      // Phase 1 — fire the 80%-warning when this call brings the user across
      // the threshold. Deduped to once-per-day inside the notifier. We use
      // dailyCount + 1 because saveAiUsage just inserted a new row.
      const newCount = dailyCount + 1;
      const warningThreshold = Math.floor(claudeLimit * 0.8);
      if (warningThreshold > 0 && newCount >= warningThreshold && newCount < claudeLimit) {
        const planName = await this.getPlanNameForLog(userId);
        void limitNotifier.maybeNotifyWarning({
          userId: Number(userId),
          used: newCount,
          limit: claudeLimit,
          planName,
        });
      }

      // Extract tool calls and conversational text from response
      const toolCalls: AgentToolCall[] = [];
      let conversationalText: string | null = null;

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          toolCalls.push({
            toolName: block.name,
            toolInput: block.input as Record<string, unknown>,
            toolUseId: block.id,
          });
        } else if (block.type === 'text' && block.text.trim()) {
          conversationalText = block.text.trim();
        }
      }

      const truncated = response.stop_reason === 'max_tokens';
      if (truncated) {
        console.warn(
          `AI_AGENT TRUNCATED: stop_reason=max_tokens — bumpear AGENT_MAX_TOKENS (actual=${resolvedMaxTokens}). ` +
            `Tools devueltos: ${toolCalls.length}`,
        );
      }

      console.log(
        `AI_AGENT (${dailyCount + 1}/${claudeLimit}):`,
        toolCalls.length > 0
          ? `tools=[${toolCalls.map(t => `${t.toolName}(${JSON.stringify(t.toolInput).slice(0, 200)})`).join(',')}]`
          : `conversational="${(conversationalText ?? '').slice(0, 100)}"`,
        `TOKENS: ${usage.input_tokens}in/${usage.output_tokens}out`,
        `CACHE: ${cacheRead}read/${cacheWrite}write`,
        `STOP: ${response.stop_reason}`,
      );

      return { toolCalls, conversationalText, usage, truncated };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const apiStatus = err instanceof Anthropic.APIError ? err.status : undefined;
      // Log BOTH timeouts and other errors — observability dashboard needs the timeout rate.
      // The error_type field distinguishes them so the UI can count separately.
      // apiStatus (429/529/5xx) llega acá ya habiendo agotado los maxRetries del SDK.
      logError(
        'ai_agent',
        isTimeout ? 'AGENT_TIMEOUT' : 'AGENT_ERROR',
        err instanceof Error ? err : new Error(String(err)),
        { context: { action: 'extract', userId, apiStatus } },
      );
      console.log('AI_AGENT: fallback to regex —', isTimeout ? 'timeout' : (err instanceof Error ? err.message : String(err)));
      return null;
    }
  }

  private async getAiDailyLimit(userId: UserId, settings: UserSettings): Promise<number> {
    try {
      const plan = await this.planRepo.getUserPlan(userId);
      if (plan?.daily_ai_limit != null) {
        return plan.daily_ai_limit;
      }
    } catch {
      // Plan lookup failed — use fallback
    }
    return settings.claude_daily_limit || 50;
  }

  /**
   * Best-effort plan-name resolution used only for log/notification context.
   * Failures are non-fatal — limit notifications still go out.
   */
  private async getPlanNameForLog(userId: UserId): Promise<string | null> {
    try {
      const plan = await this.planRepo.getUserPlan(userId);
      return plan?.name ?? null;
    } catch {
      return null;
    }
  }
}
