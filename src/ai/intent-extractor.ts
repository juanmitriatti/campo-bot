import Anthropic from '@anthropic-ai/sdk';
import { PromptBuilder } from './prompt-builder.js';
import { IntentValidator } from './intent-validator.js';
import { UserContextService } from './user-context.service.js';
import { ConversationHistoryService } from './conversation-history.service.js';
import { UserRepository } from '../domain/users/user.repository.js';
import { PlanRepository } from '../domain/billing/plan.repository.js';
import { getSetting, getSettingNumber, getSettingBool } from '../services/settings.service.js';
import { saveAiFallbackLog } from '../services/expenses.js';
import { logError } from '../services/error-logger.js';
import type { UserId, UserSettings, ParseResult, AiUsage } from '../types/index.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export class IntentExtractor {
  private planRepo: PlanRepository;

  constructor(
    private promptBuilder: PromptBuilder,
    private intentValidator: IntentValidator,
    private userContextService: UserContextService,
    private userRepo?: UserRepository,
    private historyService?: ConversationHistoryService,
  ) {
    this.planRepo = new PlanRepository();
  }

  /**
   * Attempt LLM-based intent extraction.
   * Returns ParseResult on success, null on any failure (triggers regex fallback).
   */
  async extract(
    text: string,
    preprocessed: string,
    userId: UserId,
    settings: UserSettings,
  ): Promise<ParseResult | null> {
    try {
      // Check kill switch
      const enabled = await getSettingBool('AI_INTENT_ENABLED');
      if (enabled === false) return null;

      // Check daily rate limit (plan-based, fallback to user setting)
      const claudeLimit = await this.getAiDailyLimit(userId, settings);
      const repo = this.userRepo ?? new UserRepository();
      const dailyCount = await repo.getDailyClaudeCount(userId);
      if (dailyCount >= claudeLimit) return null;

      // Load user context and conversation history in parallel
      const [userContext, historyTurns] = await Promise.allSettled([
        this.userContextService.loadContext(userId),
        this.historyService ? this.historyService.getRecentTurns(userId) : Promise.resolve([]),
      ]).then(results => [
        results[0].status === 'fulfilled' ? results[0].value : null,
        results[1].status === 'fulfilled' ? results[1].value : [],
      ] as const);

      // Build dynamic prompt
      const systemPrompt = await this.promptBuilder.build(userContext);

      // Load model settings
      const [model, maxTokens, timeoutMs] = await Promise.all([
        getSetting('AI_INTENT_MODEL'),
        getSettingNumber('AI_INTENT_MAX_TOKENS'),
        getSettingNumber('AI_INTENT_TIMEOUT_MS'),
      ]);

      const resolvedModel = model || 'claude-haiku-4-5-20251001';
      const resolvedMaxTokens = maxTokens || 300;
      const resolvedTimeout = timeoutMs || 5000;

      // Build multi-turn messages array (history + current message)
      const messages: Anthropic.MessageParam[] = [
        ...historyTurns.map(t => ({ role: t.role as 'user' | 'assistant', content: t.content })),
        { role: 'user', content: text },
      ];

      // Call Claude with timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), resolvedTimeout);

      let response: Anthropic.Message;
      try {
        response = await anthropic.messages.create(
          {
            model: resolvedModel,
            max_tokens: resolvedMaxTokens,
            temperature: 0,
            system: systemPrompt,
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

      await repo.saveAiUsage(userId, usage);
      saveAiFallbackLog(userId, text, { type: 'ai_intent' }, usage).catch(() => {});

      console.log(
        `AI_INTENT (${dailyCount + 1}/${claudeLimit}):`,
        response.content[0].type === 'text' ? response.content[0].text.slice(0, 300) : '[non-text]',
        `TOKENS: ${usage.input_tokens}in/${usage.output_tokens}out`,
      );

      // Validate and map response
      const rawText = response.content[0].type === 'text' ? response.content[0].text : '';
      const result = this.intentValidator.validate(rawText, text);

      return result;
    } catch (err) {
      // Any error → return null to trigger regex fallback
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      if (!isTimeout) {
        logError('ai_intent', 'EXTRACTION_ERROR', err instanceof Error ? err : new Error(String(err)), {
          context: { action: 'extract', userId },
        });
      }
      console.log('AI_INTENT: fallback to regex —', isTimeout ? 'timeout' : (err instanceof Error ? err.message : String(err)));
      return null;
    }
  }

  /**
   * Get AI daily limit: plan-based first, fallback to user setting.
   */
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
