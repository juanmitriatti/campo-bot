import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pool with a query function we drive per-test.
const mockQuery = vi.fn();
vi.mock('../../config/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

// Mock the channel senders so we can assert on them without doing network I/O.
const mockSendWa = vi.fn().mockResolvedValue({ success: true, attempts: 1 });
const mockSendTg = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp.js', () => ({
  sendMessageWithRetry: (...args: unknown[]) => mockSendWa(...args),
}));
vi.mock('../telegram.js', () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTg(...args),
}));

vi.mock('../error-logger.js', () => ({ logError: vi.fn() }));

import { limitNotifier } from '../limit-notifier.service.js';

beforeEach(() => {
  mockQuery.mockReset();
  mockSendWa.mockClear();
  mockSendTg.mockClear();
});

describe('LimitNotifierService — dedup', () => {
  it('claims and sends the warning when no row was stamped today', async () => {
    // 1st query: UPDATE returns one row (= we won the race)
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: 1 }] });
    // 2nd query: loadChannels — user has Telegram
    mockQuery.mockResolvedValueOnce({ rows: [{ phone: null, telegram_id: '12345' }] });

    await limitNotifier.maybeNotifyWarning({ userId: 1, used: 40, limit: 50, planName: 'pro' });

    expect(mockSendTg).toHaveBeenCalledTimes(1);
    expect(mockSendWa).not.toHaveBeenCalled();
    expect(mockSendTg.mock.calls[0][0]).toBe('12345');
    expect(mockSendTg.mock.calls[0][1]).toMatch(/quedan/i);
  });

  it('skips sending when another caller already won today', async () => {
    // UPDATE matched 0 rows — somebody beat us. Then SELECT finds the row exists.
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] });

    await limitNotifier.maybeNotifyWarning({ userId: 1, used: 40, limit: 50 });

    expect(mockSendTg).not.toHaveBeenCalled();
    expect(mockSendWa).not.toHaveBeenCalled();
  });

  it('inserts a fresh user_settings row when the user has none yet', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });        // UPDATE no-match
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });        // SELECT no row exists
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });        // INSERT...ON CONFLICT
    mockQuery.mockResolvedValueOnce({ rows: [{ last_limit_warning_at: new Date() }] }); // verify
    mockQuery.mockResolvedValueOnce({ rows: [{ phone: '+5491134567890', telegram_id: null }] }); // loadChannels

    await limitNotifier.maybeNotifyWarning({ userId: 99, used: 40, limit: 50 });

    expect(mockSendWa).toHaveBeenCalledTimes(1);
    expect(mockSendTg).not.toHaveBeenCalled();
    // Phone in alert.service strips leading '+'
    expect(mockSendWa.mock.calls[0][0]).toBe('5491134567890');
  });
});

describe('LimitNotifierService — channel selection', () => {
  it('prefers Telegram when both are linked', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ phone: '+5491134567890', telegram_id: '99' }] });

    await limitNotifier.maybeNotifyHit({ userId: 1, used: 50, limit: 50 });

    expect(mockSendTg).toHaveBeenCalledTimes(1);
    expect(mockSendWa).not.toHaveBeenCalled();
  });

  it('falls back to WhatsApp when Telegram send throws', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ phone: '+5491134567890', telegram_id: '99' }] });
    mockSendTg.mockRejectedValueOnce(new Error('TG down'));

    await limitNotifier.maybeNotifyHit({ userId: 1, used: 50, limit: 50 });

    expect(mockSendTg).toHaveBeenCalledTimes(1);
    expect(mockSendWa).toHaveBeenCalledTimes(1);
  });

  it('skips WhatsApp when only the placeholder phone (tg_*) is set', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ phone: 'tg_99', telegram_id: '99' }] });

    await limitNotifier.maybeNotifyHit({ userId: 1, used: 50, limit: 50 });

    expect(mockSendTg).toHaveBeenCalledTimes(1);
    expect(mockSendWa).not.toHaveBeenCalled();
  });

  it('logs and exits cleanly when the user has no channel linked', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ phone: null, telegram_id: null }] });

    // Should not throw
    await expect(
      limitNotifier.maybeNotifyHit({ userId: 1, used: 50, limit: 50 }),
    ).resolves.toBeUndefined();

    expect(mockSendTg).not.toHaveBeenCalled();
    expect(mockSendWa).not.toHaveBeenCalled();
  });
});

describe('LimitNotifierService — error containment', () => {
  it('never throws when a DB call rejects', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    await expect(
      limitNotifier.maybeNotifyWarning({ userId: 1, used: 40, limit: 50 }),
    ).resolves.toBeUndefined();
    expect(mockSendTg).not.toHaveBeenCalled();
    expect(mockSendWa).not.toHaveBeenCalled();
  });
});

describe('LimitNotifierService — message copy', () => {
  it('warning copy mentions remaining count + dashboard link', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ phone: null, telegram_id: '99' }] });

    await limitNotifier.maybeNotifyWarning({ userId: 1, used: 40, limit: 50 });

    const msg = mockSendTg.mock.calls[0][1] as string;
    expect(msg).toContain('10'); // 50 - 40
    expect(msg).toContain('dashboard');
  });

  it('hit copy mentions the daily limit and what still works', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ phone: null, telegram_id: '99' }] });

    await limitNotifier.maybeNotifyHit({ userId: 1, used: 50, limit: 50 });

    const msg = mockSendTg.mock.calls[0][1] as string;
    expect(msg).toMatch(/tope diario/i);
    expect(msg).toMatch(/registros simples/i);
  });
});
