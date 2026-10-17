import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '../../../types/index.js';

const mockQuery = vi.fn();
vi.mock('../../../config/db.js', () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
  // withTransaction shim that just runs the fn (no real transaction in tests)
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));

const mockClearPending = vi.fn();
vi.mock('../../../services/message-pipeline.js', () => ({
  clearAllUserPendingState: (...args: any[]) => mockClearPending(...args),
}));

const mockBcryptCompare = vi.fn();
vi.mock('bcrypt', () => ({
  default: {
    compare: (...args: any[]) => mockBcryptCompare(...args),
  },
}));

import { AccountDeletionService, AccountDeletionError } from '../account-deletion.service.js';

const userId = 1 as UserId;

describe('AccountDeletionService', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockBcryptCompare.mockReset();
    mockClearPending.mockReset();
  });

  it('rejects empty password', async () => {
    const svc = new AccountDeletionService();
    await expect(svc.deleteAccount(userId, '')).rejects.toThrow(/contraseña actual/);
  });

  it('rejects when user not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const svc = new AccountDeletionService();
    await expect(svc.deleteAccount(userId, 'pw')).rejects.toThrow(/no encontrado/);
  });

  it('rejects when already deleted', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, email: null, password_hash: '$hash', deleted_at: new Date() }],
    });
    const svc = new AccountDeletionService();
    await expect(svc.deleteAccount(userId, 'pw')).rejects.toThrow(/ya fue eliminada/);
  });

  it('rejects when wrong password', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, email: 'a@b.c', password_hash: '$hash', deleted_at: null }],
    });
    mockBcryptCompare.mockResolvedValueOnce(false);
    const svc = new AccountDeletionService();
    await expect(svc.deleteAccount(userId, 'wrong')).rejects.toThrow(/Contraseña incorrecta/);
  });

  it('soft-deletes user and revokes tokens on success', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, email: 'a@b.c', password_hash: '$hash', deleted_at: null }],
    });
    mockBcryptCompare.mockResolvedValueOnce(true);
    mockQuery.mockResolvedValueOnce({ rows: [{ phone_number: '5491100000000', telegram_id: null }] }); // canales
    mockQuery.mockResolvedValue({ rows: [] }); // UPDATE users / refresh_tokens / subscriptions

    const svc = new AccountDeletionService();
    await expect(svc.deleteAccount(userId, 'correct')).resolves.toBeUndefined();

    const sqls = mockQuery.mock.calls.map(c => String(c[0]));
    const usersUpdate = sqls.find(q => /UPDATE users/.test(q)) ?? '';
    expect(usersUpdate).toMatch(/deleted_at = NOW\(\)/);
    expect(usersUpdate).toMatch(/email = NULL/);
    expect(sqls.some(q => /UPDATE refresh_tokens/.test(q))).toBe(true);
    // CTA-6: MP seguía cobrando una cuenta borrada.
    expect(sqls.some(q => /UPDATE subscriptions/.test(q))).toBe(true);
    // Invariante 15: el estado pendiente de cada canal se limpia.
    expect(mockClearPending).toHaveBeenCalledWith('5491100000000');
    expect(mockClearPending).toHaveBeenCalledWith('testbot_1');
  });

  it('AccountDeletionError carries status and code', () => {
    const err = new AccountDeletionError(401, 'WRONG_PASSWORD', 'wrong');
    expect(err.status).toBe(401);
    expect(err.code).toBe('WRONG_PASSWORD');
  });
});
