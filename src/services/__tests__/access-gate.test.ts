import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../config/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));
vi.mock('../error-logger.js', () => ({ logError: vi.fn() }));

import { getUserAccessMode, isTrialExpired, trialExpiredCopy } from '../access-gate.service.js';

beforeEach(() => mockQuery.mockReset());

describe('getUserAccessMode', () => {
  it('grandfathers users with no subscription row → full', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getUserAccessMode(1)).toBe('full');
  });

  it('treats status=active as full (paid)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'active', trial_ends_at: null, current_period_end: new Date(Date.now() + 86_400_000) }],
    });
    expect(await getUserAccessMode(1)).toBe('full');
  });

  it('treats past_due as full (within grace, cron sweep handles it)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'past_due', trial_ends_at: null, current_period_end: null }],
    });
    expect(await getUserAccessMode(1)).toBe('full');
  });

  it('active trial (trial_ends_at in future) → full', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'trial', trial_ends_at: new Date(Date.now() + 86_400_000), current_period_end: null }],
    });
    expect(await getUserAccessMode(1)).toBe('full');
  });

  it('expired trial (trial_ends_at past) → trial_expired_readonly', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'trial', trial_ends_at: new Date(Date.now() - 60_000), current_period_end: null }],
    });
    expect(await getUserAccessMode(1)).toBe('trial_expired_readonly');
  });

  it('cancelled but still in paid period → full', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'cancelled', trial_ends_at: null, current_period_end: new Date(Date.now() + 7 * 86_400_000) }],
    });
    expect(await getUserAccessMode(1)).toBe('full');
  });

  it('cancelled past period_end → trial_expired_readonly', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'cancelled', trial_ends_at: null, current_period_end: new Date(Date.now() - 86_400_000) }],
    });
    expect(await getUserAccessMode(1)).toBe('trial_expired_readonly');
  });

  it('cancelled-trial (no period_end, trial_ends_at future) honors trial → full', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'cancelled', trial_ends_at: new Date(Date.now() + 86_400_000), current_period_end: null }],
    });
    expect(await getUserAccessMode(1)).toBe('full');
  });

  it('status=expired → trial_expired_readonly', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'expired', trial_ends_at: new Date(Date.now() - 86_400_000), current_period_end: null }],
    });
    expect(await getUserAccessMode(1)).toBe('trial_expired_readonly');
  });

  it('unknown status fails open (full)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'something_unknown', trial_ends_at: null, current_period_end: null }],
    });
    expect(await getUserAccessMode(1)).toBe('full');
  });

  it('DB error fails open (full) — never lock paying users out', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    expect(await getUserAccessMode(1)).toBe('full');
  });

  it('isTrialExpired wraps the mode check', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'expired', trial_ends_at: new Date(Date.now() - 86_400_000), current_period_end: null }],
    });
    expect(await isTrialExpired(1)).toBe(true);
  });
});

describe('trialExpiredCopy', () => {
  it('mentions data preservation and dashboard link', () => {
    const copy = trialExpiredCopy();
    expect(copy.toLowerCase()).toContain('prueba');
    expect(copy.toLowerCase()).toContain('dashboard');
    expect(copy.toLowerCase()).toMatch(/datos.+guardad/);
    // Productor-friendly: no jargon
    expect(copy.toLowerCase()).not.toContain('quota');
    expect(copy.toLowerCase()).not.toContain('credit');
  });
});
