import { describe, it, expect, vi } from 'vitest';
import { DomainRouter } from '../router.js';
import type { UserId, User, UserSettings, HandlerResponse } from '../../types/index.js';

function mockHandler(response: HandlerResponse = { messages: ['ok'] }) {
  return { handleCommand: vi.fn().mockResolvedValue(response) };
}

/** FeatureGate mock that allows all features */
const mockFeatureGate = {
  hasFeature: vi.fn().mockResolvedValue(true),
  getUserFeatures: vi.fn().mockResolvedValue([]),
  getUserPlan: vi.fn().mockResolvedValue(null),
  invalidateCache: vi.fn(),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const userId = 1 as UserId;
const user = { id: userId, name: 'Test', phone_number: '123', city: null } as User;
const settings = {} as UserSettings;

describe('DomainRouter.routeCommand', () => {
  it('routes financial commands to financial handler', async () => {
    const financial = mockHandler();
    const agronomy = mockHandler();
    const system = mockHandler();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new DomainRouter(financial as any, agronomy as any, system as any, mockFeatureGate);

    const result = await router.routeCommand({ command: 'monthly_report' }, userId, user, settings);

    expect(result).toEqual({ messages: ['ok'] });
    expect(financial.handleCommand).toHaveBeenCalled();
    expect(agronomy.handleCommand).not.toHaveBeenCalled();
    expect(system.handleCommand).not.toHaveBeenCalled();
  });

  it('routes agronomy commands to agronomy handler', async () => {
    const financial = mockHandler();
    const agronomy = mockHandler({ messages: ['rainfall logged'] });
    const system = mockHandler();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new DomainRouter(financial as any, agronomy as any, system as any, mockFeatureGate);

    const result = await router.routeCommand({ command: 'log_rainfall' }, userId, user, settings);

    expect(result).toEqual({ messages: ['rainfall logged'] });
    expect(agronomy.handleCommand).toHaveBeenCalled();
    expect(financial.handleCommand).not.toHaveBeenCalled();
  });

  it('routes system commands to system handler', async () => {
    const financial = mockHandler();
    const agronomy = mockHandler();
    const system = mockHandler({ messages: ['help text'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new DomainRouter(financial as any, agronomy as any, system as any, mockFeatureGate);

    const result = await router.routeCommand({ command: 'help' }, userId, user, settings);

    expect(result).toEqual({ messages: ['help text'] });
    expect(system.handleCommand).toHaveBeenCalled();
    expect(financial.handleCommand).not.toHaveBeenCalled();
  });

  it('routes weather commands to agronomy handler', async () => {
    const financial = mockHandler();
    const agronomy = mockHandler({ messages: ['weather'] });
    const system = mockHandler();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new DomainRouter(financial as any, agronomy as any, system as any, mockFeatureGate);

    await router.routeCommand({ command: 'weather_full' }, userId, user, settings);
    expect(agronomy.handleCommand).toHaveBeenCalled();
  });

  it('routes settings commands to system handler', async () => {
    const financial = mockHandler();
    const agronomy = mockHandler();
    const system = mockHandler({ messages: ['alerts on'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new DomainRouter(financial as any, agronomy as any, system as any, mockFeatureGate);

    await router.routeCommand({ command: 'enable_rain_alerts' }, userId, user, settings);
    expect(system.handleCommand).toHaveBeenCalled();
  });

  it('returns null for unknown commands', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new DomainRouter(mockHandler() as any, mockHandler() as any, mockHandler() as any, mockFeatureGate);
    const result = await router.routeCommand({ command: 'nonexistent_xyz' }, userId, user, settings);
    expect(result).toBeNull();
  });

  it('passes correct args to handler', async () => {
    const financial = mockHandler();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new DomainRouter(financial as any, mockHandler() as any, mockHandler() as any, mockFeatureGate);

    const cmd = { command: 'monthly_report' };
    await router.routeCommand(cmd, userId, user, settings);

    expect(financial.handleCommand).toHaveBeenCalledWith(cmd, userId, user, settings);
  });

  it('blocks command when feature is not available', async () => {
    const blockedGate = {
      hasFeature: vi.fn().mockResolvedValue(false),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const financial = mockHandler();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new DomainRouter(financial as any, mockHandler() as any, mockHandler() as any, blockedGate);

    const result = await router.routeCommand({ command: 'set_budget' }, userId, user, settings);

    expect(result?.messages[0]).toContain('🔒');
    expect(financial.handleCommand).not.toHaveBeenCalled();
  });
});
