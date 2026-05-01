import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '../../../types/index.js';

const mockQuery = vi.fn();
vi.mock('../../../config/db.js', () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
  // withTransaction shim that just runs the fn (no real transaction in tests)
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
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
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE users
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE refresh_tokens

    const svc = new AccountDeletionService();
    await expect(svc.deleteAccount(userId, 'correct')).resolves.toBeUndefined();

    // verify queries: lookup, UPDATE users (with deleted_at), UPDATE refresh_tokens
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[1][0]).toMatch(/UPDATE users/);
    expect(mockQuery.mock.calls[1][0]).toMatch(/deleted_at = NOW\(\)/);
    expect(mockQuery.mock.calls[1][0]).toMatch(/email = NULL/);
    expect(mockQuery.mock.calls[2][0]).toMatch(/UPDATE refresh_tokens/);
  });

  it('AccountDeletionError carries status and code', () => {
    const err = new AccountDeletionError(401, 'WRONG_PASSWORD', 'wrong');
    expect(err.status).toBe(401);
    expect(err.code).toBe('WRONG_PASSWORD');
  });
});
