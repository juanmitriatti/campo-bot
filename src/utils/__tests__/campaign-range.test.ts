import { describe, it, expect } from 'vitest';
import { campaignRange, currentSeasonYear, resolveCampaign, recentCampaigns } from '../campaign-range.js';
import { getSeasonYear } from '../../domain/plots/crop.service.js';

describe('campaignRange', () => {
  it('spans September to August, matching the gruesa season window', () => {
    const r = campaignRange(2025);
    expect(r.from).toBe('2025-09-01');
    expect(r.to).toBe('2026-08-31');
    expect(r.label).toBe('2025/26');
    expect(r.seasonYear).toBe(2025);
  });

  it('agrees with the domain definition it reuses', () => {
    // Every day inside the window must resolve to the same season year via the
    // crop service — that agreement is the whole point of not defining a second
    // campaign concept for the money side.
    for (const day of ['2025-09-01', '2025-12-31', '2026-01-01', '2026-08-31']) {
      const d = new Date(`${day}T12:00:00Z`);
      expect(getSeasonYear(d, 'gruesa')).toBe(2025);
    }
    // And the day either side must NOT.
    expect(getSeasonYear(new Date('2025-08-31T12:00:00Z'), 'gruesa')).toBe(2024);
    expect(getSeasonYear(new Date('2026-09-01T12:00:00Z'), 'gruesa')).toBe(2026);
  });
});

describe('currentSeasonYear', () => {
  it('puts Jan–Aug in the campaign that started the previous September', () => {
    expect(currentSeasonYear(new Date('2026-07-19T12:00:00Z'))).toBe(2025);
    expect(currentSeasonYear(new Date('2026-02-10T12:00:00Z'))).toBe(2025);
  });

  it('rolls over in September', () => {
    expect(currentSeasonYear(new Date('2026-09-01T12:00:00Z'))).toBe(2026);
    expect(currentSeasonYear(new Date('2026-11-20T12:00:00Z'))).toBe(2026);
  });
});

describe('resolveCampaign', () => {
  const now = new Date('2026-07-19T12:00:00Z');

  it('accepts a bare season year', () => {
    expect(resolveCampaign('2024', now).seasonYear).toBe(2024);
  });

  it('accepts a label, taking the first half', () => {
    expect(resolveCampaign('25/26', now).seasonYear).toBe(2025);
    expect(resolveCampaign('2025/26', now).seasonYear).toBe(2025);
  });

  it('falls back to the current campaign instead of throwing', () => {
    // A bad param must never 400 the whole Resumen — worst case the user sees
    // the current campaign rather than an error page.
    for (const bad of [undefined, null, '', '   ', 'pepe', '99999', {}, []]) {
      expect(resolveCampaign(bad, now).seasonYear).toBe(2025);
    }
  });
});

describe('recentCampaigns', () => {
  it('lists newest first, contiguous', () => {
    const list = recentCampaigns(4, new Date('2026-07-19T12:00:00Z'));
    expect(list.map(c => c.seasonYear)).toEqual([2025, 2024, 2023, 2022]);
    expect(list[0].label).toBe('2025/26');
  });
});
