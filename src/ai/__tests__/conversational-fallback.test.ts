import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationalFallbackService } from '../conversational-fallback.service.js';

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'El trigo se cosecha entre noviembre y enero.' }],
    usage: { input_tokens: 85, output_tokens: 18 },
  });
  return {
    default: class {
      messages = { create };
    },
  };
});

// Mock settings
vi.mock('../../services/settings.service.js', () => ({
  getSettingBool: vi.fn().mockResolvedValue(true),
  getSetting: vi.fn().mockResolvedValue(null),
  getSettingNumber: vi.fn().mockResolvedValue(null),
}));

// Mock expenses log
vi.mock('../../services/expenses.js', () => ({
  saveAiFallbackLog: vi.fn().mockResolvedValue(undefined),
}));

// Mock error logger
vi.mock('../../services/error-logger.js', () => ({
  logError: vi.fn(),
}));

// Mock UserRepository
vi.mock('../../domain/users/user.repository.js', () => ({
  UserRepository: class {
    getDailyClaudeCount = vi.fn().mockResolvedValue(0);
    saveAiUsage = vi.fn().mockResolvedValue(undefined);
  },
}));

// Mock PlanRepository — defaults to "no plan limit" so tests fall back to
// settings.claude_daily_limit. Override per-test if needed.
vi.mock('../../domain/billing/plan.repository.js', () => ({
  PlanRepository: class {
    getUserPlanAiLimit = vi.fn().mockResolvedValue(null);
  },
}));

describe('ConversationalFallbackService', () => {
  const mockSettings = {
    confirm_before_save: false,
    claude_daily_limit: 50,
    max_fields: 10,
  };

  beforeEach(() => {
    ConversationalFallbackService.resetRateLimits();
    vi.clearAllMocks();
  });

  describe('respond', () => {
    it('returns AI response for a general agriculture question', async () => {
      const service = new ConversationalFallbackService();
      const result = await service.respond('cuándo se cosecha el trigo?', 1, mockSettings);

      expect(result.aiUsed).toBe(true);
      expect(result.rateLimited).toBe(false);
      expect(result.response).toBeTruthy();
      expect(result.usage).toBeDefined();
      expect(result.usage!.input_tokens).toBeLessThanOrEqual(200);
      expect(result.usage!.output_tokens).toBeLessThanOrEqual(120);
    });

    it('returns rate limit response when disabled via setting', async () => {
      const { getSettingBool } = await import('../../services/settings.service.js');
      (getSettingBool as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      const service = new ConversationalFallbackService();
      const result = await service.respond('hola', 1, mockSettings);

      expect(result.aiUsed).toBe(false);
      expect(result.response).toBe(ConversationalFallbackService.rateLimitResponse);
    });

    it('returns rate limit response when daily limit reached', async () => {
      const { UserRepository } = await import('../../domain/users/user.repository.js');
      const repo = new UserRepository();
      (repo.getDailyClaudeCount as ReturnType<typeof vi.fn>).mockResolvedValue(50);

      const service = new ConversationalFallbackService(repo as any);
      const result = await service.respond('qué es la soja?', 1, mockSettings);

      expect(result.aiUsed).toBe(false);
      expect(result.rateLimited).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('allows up to 5 requests within 10 minutes', async () => {
      const service = new ConversationalFallbackService();

      for (let i = 0; i < 5; i++) {
        const result = await service.respond(`pregunta ${i}`, 1, mockSettings);
        expect(result.aiUsed).toBe(true);
      }

      // 6th should be rate limited
      const result = await service.respond('otra pregunta', 1, mockSettings);
      expect(result.rateLimited).toBe(true);
      expect(result.aiUsed).toBe(false);
    });

    it('rate limits are per-user', async () => {
      const service = new ConversationalFallbackService();

      // Exhaust user 1
      for (let i = 0; i < 5; i++) {
        await service.respond(`pregunta ${i}`, 1, mockSettings);
      }

      // User 2 should still work
      const result = await service.respond('pregunta', 2, mockSettings);
      expect(result.aiUsed).toBe(true);
      expect(result.rateLimited).toBe(false);
    });
  });

  describe('prompt constraints', () => {
    it('system prompt stays compact (under 350 tokens)', () => {
      const prompt = ConversationalFallbackService.systemPrompt;
      // Conservative estimate: ~1 token per 4 chars for Spanish.
      // Threshold is a guard against bloat, bumped from 150 → 350 as the
      // prompt grew with disambiguation rules. Keep it well under a
      // typical fallback budget so the conversational call stays cheap.
      const estimatedTokens = Math.ceil(prompt.length / 4);
      expect(estimatedTokens).toBeLessThan(350);
    });

    it('rate limit response is in Spanish', () => {
      const response = ConversationalFallbackService.rateLimitResponse;
      expect(response).toContain('gastos');
      expect(response).toContain('reportes');
    });
  });
});
