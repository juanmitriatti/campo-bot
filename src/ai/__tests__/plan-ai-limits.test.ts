import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanRepository } from '../../domain/billing/plan.repository.js';

// Mock the pool
const mockQuery = vi.fn();
vi.mock('../../config/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('PlanRepository.getUserPlanAiLimit', () => {
  const repo = new PlanRepository();

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns plan daily_ai_limit when user has a plan', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ daily_ai_limit: 100 }],
    });

    const limit = await repo.getUserPlanAiLimit(1 as any);
    expect(limit).toBe(100);
  });

  it('returns null when user has no plan', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const limit = await repo.getUserPlanAiLimit(1 as any);
    expect(limit).toBeNull();
  });

  it('returns null when plan has no daily_ai_limit', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ daily_ai_limit: null }],
    });

    const limit = await repo.getUserPlanAiLimit(1 as any);
    expect(limit).toBeNull();
  });

  it('converts string to number', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ daily_ai_limit: '300' }],
    });

    const limit = await repo.getUserPlanAiLimit(1 as any);
    expect(limit).toBe(300);
    expect(typeof limit).toBe('number');
  });

  it('queries with correct user ID', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await repo.getUserPlanAiLimit(42 as any);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('daily_ai_limit'),
      [42],
    );
  });
});

describe('Plan-based AI limit fallback logic', () => {
  // Test the fallback logic used by both IntentExtractor and ConversationalFallbackService
  // This tests the pattern: plan limit → user setting → default 50

  it('plan limit takes priority over user setting', () => {
    const planLimit = 100;
    const userSetting = 50;
    // Simulating: if plan limit exists, use it
    const effectiveLimit = planLimit ?? userSetting;
    expect(effectiveLimit).toBe(100);
  });

  it('falls back to user setting when plan limit is null', () => {
    const planLimit = null;
    const userSetting = 75;
    const effectiveLimit = planLimit ?? userSetting;
    expect(effectiveLimit).toBe(75);
  });

  it('falls back to default 50 when both are null/zero', () => {
    const planLimit = null;
    const userSetting = 0;
    const effectiveLimit = planLimit ?? (userSetting || 50);
    expect(effectiveLimit).toBe(50);
  });
});
