import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '../../../types/index.js';

// Mock pool
const mockQuery = vi.fn();
vi.mock('../../../config/db.js', () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
}));

// Mock WhatsApp send (so we don't hit Cloud API)
const mockSendWhatsApp = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../services/whatsapp.js', () => ({
  sendMessage: (...args: any[]) => mockSendWhatsApp(...args),
}));

// Mock settings (default OTP values)
vi.mock('../../../services/settings.service.js', () => ({
  getSetting: vi.fn(async (key: string) => {
    if (key === 'TELEGRAM_BOT_USERNAME') return 'CampoBotTest';
    return null;
  }),
  getSettingNumber: vi.fn(async () => null), // service falls back to defaults
  getSettingBool: vi.fn(async () => false),
}));

import { ChannelVerificationService, VerificationError } from '../channel-verification.service.js';

const userId = 1 as UserId;

function setRowsForCall(callIndex: number, rows: any[]) {
  // queue up sequential return values
  mockQuery.mockImplementationOnce(() => Promise.resolve({ rows }));
}

describe('ChannelVerificationService — startWhatsApp', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSendWhatsApp.mockClear();
    mockSendWhatsApp.mockResolvedValue(undefined);
  });

  it('rejects empty phone', async () => {
    const svc = new ChannelVerificationService();
    await expect(svc.startWhatsApp(userId, '')).rejects.toThrow(VerificationError);
  });

  it('rejects malformed phone', async () => {
    const svc = new ChannelVerificationService();
    // 6-char input passes the length check but fails the e164 regex (too short after +54 prepend)
    await expect(svc.startWhatsApp(userId, '123456')).rejects.toThrow(/Número inválido/);
  });

  it('normalizes AR phone, persists code, sends WhatsApp', async () => {
    setRowsForCall(0, []); // no conflict
    setRowsForCall(1, []); // invalidate previous (UPDATE returns no rows)
    setRowsForCall(2, []); // INSERT returns no rows (we don't read them)

    const svc = new ChannelVerificationService();
    const r = await svc.startWhatsApp(userId, '11 5512 3456');

    expect(r.ttl_minutes).toBe(10); // default
    expect(new Date(r.expires_at).getTime()).toBeGreaterThan(Date.now());

    // Verify WhatsApp send was called with normalized phone (no leading +)
    expect(mockSendWhatsApp).toHaveBeenCalledTimes(1);
    const [phoneArg, msgArg] = mockSendWhatsApp.mock.calls[0];
    expect(phoneArg).toBe('541155123456'); // +54 prepended, leading 0 stripped, + dropped for Cloud API
    expect(msgArg).toContain('código');
    // The message must contain a 6-digit code formatted as `XXXXXX`
    expect(msgArg).toMatch(/`\d{6}`/);
  });

  it('rejects when phone is taken by another verified user', async () => {
    setRowsForCall(0, [{ id: 99 }]); // conflict found
    const svc = new ChannelVerificationService();
    await expect(svc.startWhatsApp(userId, '+541155123456')).rejects.toThrow(/ya está vinculado/);
    expect(mockSendWhatsApp).not.toHaveBeenCalled();
  });

  it('throws SEND_FAILED when WhatsApp API errors', async () => {
    setRowsForCall(0, []);
    setRowsForCall(1, []);
    setRowsForCall(2, []);
    mockSendWhatsApp.mockRejectedValueOnce(new Error('network error'));
    const svc = new ChannelVerificationService();
    await expect(svc.startWhatsApp(userId, '+541155123456')).rejects.toThrow(/No pude enviar el código/);
  });
});

describe('ChannelVerificationService — confirmWhatsApp', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSendWhatsApp.mockClear();
  });

  it('rejects non-6-digit code', async () => {
    const svc = new ChannelVerificationService();
    await expect(svc.confirmWhatsApp(userId, 'abc')).rejects.toThrow(/6 dígitos/);
    await expect(svc.confirmWhatsApp(userId, '12345')).rejects.toThrow(/6 dígitos/);
  });

  it('rejects when no pending verification exists', async () => {
    setRowsForCall(0, []); // no row found
    const svc = new ChannelVerificationService();
    await expect(svc.confirmWhatsApp(userId, '123456')).rejects.toThrow(/No hay un código pendiente/);
  });

  it('rejects expired code', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    setRowsForCall(0, [{ id: 1, code: '123456', target: '+5491155123456', attempts: 0, expires_at: past }]);
    const svc = new ChannelVerificationService();
    await expect(svc.confirmWhatsApp(userId, '123456')).rejects.toThrow(/expiró/);
  });

  it('rejects too many attempts', async () => {
    const future = new Date(Date.now() + 60 * 1000);
    setRowsForCall(0, [{ id: 1, code: '123456', target: '+541155123456', attempts: 5, expires_at: future }]);
    const svc = new ChannelVerificationService();
    await expect(svc.confirmWhatsApp(userId, '123456')).rejects.toThrow(/Demasiados intentos/);
  });

  it('rejects wrong code and increments attempts', async () => {
    const future = new Date(Date.now() + 60 * 1000);
    setRowsForCall(0, [{ id: 1, code: '654321', target: '+541155123456', attempts: 0, expires_at: future }]);
    setRowsForCall(1, []); // UPDATE attempts
    const svc = new ChannelVerificationService();
    await expect(svc.confirmWhatsApp(userId, '123456')).rejects.toThrow(/Código incorrecto/);
    // Verify the UPDATE attempts query was called
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toMatch(/UPDATE channel_verifications.*attempts/i);
  });

  it('marks user verified on correct code', async () => {
    const future = new Date(Date.now() + 60 * 1000);
    setRowsForCall(0, [{ id: 7, code: '123456', target: '+541155123456', attempts: 0, expires_at: future }]);
    setRowsForCall(1, []); // race-check: no conflict
    setRowsForCall(2, []); // mark verified_at
    setRowsForCall(3, []); // UPDATE users phone + whatsapp_verified_at
    setRowsForCall(4, [{
      phone_number: '+541155123456',
      telegram_id: null,
      whatsapp_verified_at: new Date(),
      telegram_verified_at: null,
    }]);

    const svc = new ChannelVerificationService();
    const status = await svc.confirmWhatsApp(userId, '123456');

    expect(status.whatsapp_verified).toBe(true);
    expect(status.telegram_verified).toBe(false);
    expect(status.phone_number).toBe('+541155123456');
  });
});

describe('ChannelVerificationService — telegram', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('startTelegramLink generates deep-link with bot username', async () => {
    setRowsForCall(0, []); // invalidate previous
    setRowsForCall(1, []); // INSERT
    const svc = new ChannelVerificationService();
    const r = await svc.startTelegramLink(userId);

    expect(r.deep_link).toMatch(/^https:\/\/t\.me\/CampoBotTest\?start=verify_/);
    expect(r.token.length).toBeGreaterThan(20);
    expect(new Date(r.expires_at).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it('redeemTelegramToken rejects invalid token', async () => {
    const svc = new ChannelVerificationService();
    await expect(svc.redeemTelegramToken('short', '123', null)).rejects.toThrow(/inválido/);
  });

  it('redeemTelegramToken rejects unknown token', async () => {
    setRowsForCall(0, []);
    const svc = new ChannelVerificationService();
    await expect(svc.redeemTelegramToken('a'.repeat(32), '123', null)).rejects.toThrow(/no es válido o ya fue usado/);
  });

  it('redeemTelegramToken rejects expired token', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    setRowsForCall(0, [{ id: 1, user_id: 5, expires_at: past }]);
    const svc = new ChannelVerificationService();
    await expect(svc.redeemTelegramToken('a'.repeat(32), '123', null)).rejects.toThrow(/expiró/);
  });

  it('redeemTelegramToken rejects when telegram already linked elsewhere', async () => {
    const future = new Date(Date.now() + 60 * 1000);
    setRowsForCall(0, [{ id: 1, user_id: 5, expires_at: future }]);
    setRowsForCall(1, [{ id: 99 }]); // another user has this telegram_id
    const svc = new ChannelVerificationService();
    await expect(svc.redeemTelegramToken('a'.repeat(32), '999', null)).rejects.toThrow(/ya está vinculado/);
  });

  it('redeemTelegramToken links successfully', async () => {
    const future = new Date(Date.now() + 60 * 1000);
    setRowsForCall(0, [{ id: 1, user_id: 5, expires_at: future }]);
    setRowsForCall(1, []); // no conflict
    setRowsForCall(2, [{ telegram_verified_at: null }]); // not yet linked
    setRowsForCall(3, []); // mark verified_at
    setRowsForCall(4, []); // update users

    const svc = new ChannelVerificationService();
    const r = await svc.redeemTelegramToken('a'.repeat(32), '999', 'Juan');
    expect(r.user_id).toBe(5);
    expect(r.already_linked).toBe(false);
  });
});
