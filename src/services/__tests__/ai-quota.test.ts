import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { notifyHit } = vi.hoisted(() => ({ notifyHit: vi.fn(async () => undefined) }));
vi.mock('../limit-notifier.service.js', () => ({ limitNotifier: { maybeNotifyHit: notifyHit, maybeNotifyWarning: vi.fn() } }));

import { getAiDailyLimit, getAiQuota, assertAiQuota, AiQuotaExceededError, setAiQuotaReposForTests } from '../ai-quota.service.js';
import type { PlanRepository } from '../../domain/billing/plan.repository.js';
import type { UserRepository } from '../../domain/users/user.repository.js';
import type { UserId } from '../../types/index.js';

const U = 1 as unknown as UserId;

function fakes(opts: { planLimit: number | null; used: number; settingLimit?: number; planName?: string }) {
  const plans = {
    getUserPlanAiLimit: vi.fn(async () => opts.planLimit),
    getUserPlan: vi.fn(async () => ({ name: opts.planName ?? 'pro' })),
  } as unknown as PlanRepository;
  const users = {
    getDailyClaudeCount: vi.fn(async () => opts.used),
    getSettings: vi.fn(async () => ({ claude_daily_limit: opts.settingLimit ?? 0 })),
  } as unknown as UserRepository;
  setAiQuotaReposForTests({ plans, users });
  return { plans, users };
}

describe('ai-quota.service — fuente única de la cuota diaria de IA', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => setAiQuotaReposForTests(null));

  it('el límite del plan manda; sin plan cae al setting del usuario; sin nada, 50', async () => {
    fakes({ planLimit: 100, used: 0 });
    expect(await getAiDailyLimit(U)).toBe(100);

    fakes({ planLimit: null, used: 0, settingLimit: 30 });
    expect(await getAiDailyLimit(U)).toBe(30);
    // settings pasados por el caller evitan la query
    expect(await getAiDailyLimit(U, { claude_daily_limit: 12 } as never)).toBe(12);

    fakes({ planLimit: null, used: 0 });
    expect(await getAiDailyLimit(U)).toBe(50);
  });

  it('getAiQuota calcula used/limit/remaining/exhausted', async () => {
    fakes({ planLimit: 20, used: 18, planName: 'pro' });
    expect(await getAiQuota(U)).toEqual({ used: 18, limit: 20, remaining: 2, exhausted: false, planName: 'pro' });
    fakes({ planLimit: 20, used: 25 });
    expect(await getAiQuota(U)).toMatchObject({ remaining: 0, exhausted: true });
  });

  it('assertAiQuota lanza 429 al tope y avisa por el canal del bot una vez', async () => {
    fakes({ planLimit: 5, used: 5, planName: 'free' });
    const err = await assertAiQuota(U).catch((e) => e);
    expect(err).toBeInstanceOf(AiQuotaExceededError);
    expect(err.status).toBe(429);
    expect(err.message).toContain('tope diario');
    expect(err.message).toContain('(5)');
    expect(notifyHit).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, used: 5, limit: 5, planName: 'free' }));

    fakes({ planLimit: 5, used: 4 });
    await expect(assertAiQuota(U)).resolves.toMatchObject({ remaining: 1 });
  });
});
