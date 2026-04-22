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
import type { UserId, UserSettings, AiUsage } from '../types/index.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
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
  ): Promise<AgentResult | null> {
    try {
      // Check kill switch
      const enabled = await getSettingBool('AGENT_ENABLED');
      if (enabled !== true) return null;

      // Check daily rate limit (plan-based, fallback to user setting)
      const claudeLimit = await this.getAiDailyLimit(userId, settings);
      const repo = this.userRepo ?? new UserRepository();
      const dailyCount = await repo.getDailyClaudeCount(userId);
      if (dailyCount >= claudeLimit) return null;

      // Load user context, conversation history, and few-shot examples in parallel
      const historyMaxChars = (await getSettingNumber('CONVERSATION_HISTORY_MAX_CHARS')) ?? 4000;
      const fewShotLimit = (await getSettingNumber('AGENT_FEW_SHOT_LIMIT')) ?? 5;
      const [userContext, historyTurns, fewShotExamples, dictionary] = await Promise.allSettled([
        this.userContextService.loadContext(userId),
        this.historyService ? this.historyService.getRecentTurns(userId, historyMaxChars) : Promise.resolve([]),
        this.fewShotService ? this.fewShotService.getExamples(fewShotLimit) : Promise.resolve([]),
        getActivityDictionary(),
      ]).then(results => [
        results[0].status === 'fulfilled' ? results[0].value : null,
        results[1].status === 'fulfilled' ? results[1].value : [],
        results[2].status === 'fulfilled' ? results[2].value : [],
        results[3].status === 'fulfilled' ? results[3].value : undefined,
      ] as const);

      // Build system prompt (stable — cacheable across users/calls).
      // Per-user context + today's date are injected into the user message
      // prefix so they don't invalidate the cache.
      const systemPrompt = this.promptBuilder.build(null, dictionary);
      const userPrefix = this.promptBuilder.buildUserMessagePrefix(userContext);

      // Load agent-specific settings
      const [model, maxTokens, timeoutMs, temperatureStr, cacheTtlSetting] = await Promise.all([
        getSetting('AGENT_MODEL'),
        getSettingNumber('AGENT_MAX_TOKENS'),
        getSettingNumber('AGENT_TIMEOUT_MS'),
        getSetting('AGENT_TEMPERATURE'),
        getSetting('AGENT_CACHE_TTL'),
      ]);

      const resolvedModel = model || 'claude-haiku-4-5-20251001';
      const resolvedMaxTokens = maxTokens || 400;
      const resolvedTimeout = timeoutMs || 8000;
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

      const userContent = userPrefix ? `${userPrefix}\n\n${text}` : text;
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
      const usage: AiUsage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      };
      const cacheRead = response.usage.cache_read_input_tokens ?? 0;
      const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;

      await repo.saveAiUsage(userId, usage);
      saveAiFallbackLog(userId, text, { type: 'agent_tool_use' }, usage).catch(() => {});

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

      console.log(
        `AI_AGENT (${dailyCount + 1}/${claudeLimit}):`,
        toolCalls.length > 0
          ? `tools=[${toolCalls.map(t => t.toolName).join(',')}]`
          : `conversational="${(conversationalText ?? '').slice(0, 100)}"`,
        `TOKENS: ${usage.input_tokens}in/${usage.output_tokens}out`,
        `CACHE: ${cacheRead}read/${cacheWrite}write`,
      );

      return { toolCalls, conversationalText, usage };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      if (!isTimeout) {
        logError('ai_agent', 'AGENT_ERROR', err instanceof Error ? err : new Error(String(err)), {
          context: { action: 'extract', userId },
        });
      }
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
}
