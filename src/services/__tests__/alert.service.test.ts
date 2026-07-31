import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/db.js', () => ({
  pool: { query: vi.fn() },
}));
vi.mock('../whatsapp.js', () => ({
  sendMessageWithRetry: vi.fn(),
}));
vi.mock('../telegram.ts', () => ({
  sendTelegramMessage: vi.fn(),
}));
vi.mock('../error-logger.js', () => ({
  logError: vi.fn(),
}));

import { sendAlertWithRetry, sendAlertWithRetryMultiChannel } from '../alert.service.js';
import { pool } from '../../config/db.js';
import { sendMessageWithRetry } from '../whatsapp.js';
import { sendTelegramMessage } from '../telegram.ts';
import { logError } from '../error-logger.js';

const mockQuery = pool.query as ReturnType<typeof vi.fn>;
const mockWhatsApp = sendMessageWithRetry as ReturnType<typeof vi.fn>;
const mockTelegram = sendTelegramMessage as ReturnType<typeof vi.fn>;
const mockLogError = logError as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: INSERT returns alertId 42
  mockQuery.mockResolvedValue({ rows: [{ id: 42 }] });
});

// ─── sendAlertWithRetryMultiChannel — Routing ────────────────────────

describe('sendAlertWithRetryMultiChannel — routing', () => {
  it('uses Telegram when telegramId is set', async () => {
    mockTelegram.mockResolvedValue(undefined);

    const res = await sendAlertWithRetryMultiChannel(1, { telegramId: '123' }, 'msg', 'budget_80');

    expect(res.sent).toBe(true);
    expect(mockTelegram).toHaveBeenCalledWith('123', 'msg');
    expect(mockWhatsApp).not.toHaveBeenCalled();
  });

  it('falls back to WhatsApp when only phone is set', async () => {
    mockWhatsApp.mockResolvedValue({ success: true, attempts: 1 });

    const res = await sendAlertWithRetryMultiChannel(1, { phone: '5491155550000' }, 'msg', 'budget_80');

    expect(res.sent).toBe(true);
    expect(mockWhatsApp).toHaveBeenCalledWith('5491155550000', 'msg');
    expect(mockTelegram).not.toHaveBeenCalled();
  });

  it('returns sent:false and updates DB to failed when no channel available', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await sendAlertWithRetryMultiChannel(1, {}, 'msg', 'budget_80');

    expect(res.sent).toBe(false);
    expect(mockTelegram).not.toHaveBeenCalled();
    expect(mockWhatsApp).not.toHaveBeenCalled();
    // INSERT + UPDATE to 'failed'
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toContain("status = 'failed'");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('extracts telegramId from tg_ phone placeholder', async () => {
    mockTelegram.mockResolvedValue(undefined);

    const res = await sendAlertWithRetryMultiChannel(
      1,
      { phone: 'tg_8629094580' },
      'msg',
      'budget_80',
    );

    expect(res.sent).toBe(true);
    expect(mockTelegram).toHaveBeenCalledWith('8629094580', 'msg');
    expect(mockWhatsApp).not.toHaveBeenCalled();
  });

  it('prefers Telegram when both telegramId and phone are set', async () => {
    mockTelegram.mockResolvedValue(undefined);

    const res = await sendAlertWithRetryMultiChannel(
      1,
      { telegramId: '123', phone: '5491155550000' },
      'msg',
      'budget_80',
    );

    expect(res.sent).toBe(true);
    expect(mockTelegram).toHaveBeenCalled();
    expect(mockWhatsApp).not.toHaveBeenCalled();
  });
});

// ─── sendAlertWithRetryMultiChannel — Telegram Retry ─────────────────

describe('sendAlertWithRetryMultiChannel — Telegram retry', () => {
  it('succeeds on first attempt', async () => {
    mockTelegram.mockResolvedValue(undefined);

    const res = await sendAlertWithRetryMultiChannel(1, { telegramId: '123' }, 'msg', 'budget_80');

    expect(res.sent).toBe(true);
    expect(mockTelegram).toHaveBeenCalledTimes(1);
  });

  it('succeeds on retry after first failure', async () => {
    mockTelegram
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined);

    const res = await sendAlertWithRetryMultiChannel(1, { telegramId: '123' }, 'msg', 'budget_80');

    expect(res.sent).toBe(true);
    expect(mockTelegram).toHaveBeenCalledTimes(2);
  }, 10000);

  it('fails after 3 attempts and calls logError', async () => {
    const err = new Error('network');
    mockTelegram.mockRejectedValue(err);

    const res = await sendAlertWithRetryMultiChannel(1, { telegramId: '123' }, 'msg', 'budget_80');

    expect(res.sent).toBe(false);
    expect(mockTelegram).toHaveBeenCalledTimes(3);
    expect(mockLogError).toHaveBeenCalledWith(
      'alerts',
      'ALERT_SEND_FAILED',
      err,
      expect.objectContaining({ userId: 1, alertType: 'budget_80' }),
    );
  }, 15000);
});

// ─── sendAlertWithRetryMultiChannel — WhatsApp Path ──────────────────

describe('sendAlertWithRetryMultiChannel — WhatsApp path', () => {
  it('returns sent:true when WhatsApp succeeds', async () => {
    mockWhatsApp.mockResolvedValue({ success: true, attempts: 1 });

    const res = await sendAlertWithRetryMultiChannel(1, { phone: '549' }, 'msg', 'budget_80');

    expect(res.sent).toBe(true);
  });

  it('returns sent:false and calls logError when WhatsApp fails', async () => {
    mockWhatsApp.mockResolvedValue({ success: false, attempts: 3, error: 'api down' });

    const res = await sendAlertWithRetryMultiChannel(1, { phone: '549' }, 'msg', 'budget_80');

    expect(res.sent).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      'alerts',
      'ALERT_SEND_FAILED',
      expect.any(Error),
      expect.objectContaining({ context: expect.objectContaining({ channel: 'whatsapp' }) }),
    );
  });
});

// ─── sendAlertWithRetryMultiChannel — DB Persistence ─────────────────

describe('sendAlertWithRetryMultiChannel — DB persistence', () => {
  it('inserts with status retrying as first query', async () => {
    mockTelegram.mockResolvedValue(undefined);

    await sendAlertWithRetryMultiChannel(1, { telegramId: '123' }, 'msg', 'budget_80');

    const insertSql = mockQuery.mock.calls[0][0] as string;
    expect(insertSql).toContain('INSERT INTO alert_history');
    expect(insertSql).toContain("'retrying'");
  });

  it('updates to sent on success', async () => {
    mockTelegram.mockResolvedValue(undefined);

    await sendAlertWithRetryMultiChannel(1, { telegramId: '123' }, 'msg', 'budget_80');

    const updateSql = mockQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("status = 'sent'");
  });
});

// ─── sendAlertWithRetry — Sanity ─────────────────────────────────────

describe('sendAlertWithRetry — sanity', () => {
  it('succeeds: inserts + WhatsApp ok + updates sent', async () => {
    mockWhatsApp.mockResolvedValue({ success: true, attempts: 1 });

    const res = await sendAlertWithRetry(1, '549', 'msg', 'budget_80');

    expect(res.sent).toBe(true);
    expect(res.alertId).toBe(42);
    // INSERT + UPDATE
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect((mockQuery.mock.calls[1][0] as string)).toContain("status = 'sent'");
  });

  it('fails: inserts + WhatsApp fails + updates failed + logError', async () => {
    mockWhatsApp.mockResolvedValue({ success: false, attempts: 3, error: 'down' });

    const res = await sendAlertWithRetry(1, '549', 'msg', 'budget_80');

    expect(res.sent).toBe(false);
    expect((mockQuery.mock.calls[1][0] as string)).toContain("status = 'failed'");
    expect(mockLogError).toHaveBeenCalled();
  });
});

// ─── Gate de opt-out (alertas proactivas, migración 103) ─────────────

describe('gate de opt-out para alertas proactivas', () => {
  it('saltea el envío (sin INSERT) cuando el usuario optó por no recibir', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] }); // SELECT alerts_enabled

    const res = await sendAlertWithRetryMultiChannel(1, { telegramId: '123' }, 'msg', 'weather');

    expect(res).toEqual({ sent: false, skipped: 'opt_out' });
    expect(mockTelegram).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1); // solo el SELECT del gate
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[INTERCEPT]'));
    logSpy.mockRestore();
  });

  it('agrega el footer de baja cuando la alerta proactiva sí se envía', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] }); // SELECT del gate
    mockTelegram.mockResolvedValue(undefined);

    const res = await sendAlertWithRetryMultiChannel(1, { telegramId: '123' }, 'msg', 'weather');

    expect(res.sent).toBe(true);
    expect(mockTelegram).toHaveBeenCalledWith('123', expect.stringContaining('no más alertas'));
  });

  it('usuario sin fila en user_settings recibe la alerta (default true)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT del gate: sin fila
    mockTelegram.mockResolvedValue(undefined);

    const res = await sendAlertWithRetry(1, 'tg_99', 'msg', 'weather');

    expect(res.sent).toBe(true);
  });

  it('los tipos NO proactivos no consultan opt-out ni llevan footer', async () => {
    mockWhatsApp.mockResolvedValue({ success: true, attempts: 1 });

    await sendAlertWithRetry(1, '549', 'msg', 'monthly_summary');

    expect(mockWhatsApp).toHaveBeenCalledWith('549', 'msg');
    expect((mockQuery.mock.calls[0][0] as string)).toContain('INSERT INTO alert_history');
  });
});
