/**
 * Campaign window for the money side of the dashboard.
 *
 * The domain already defines "campaña" per crop, in `domain/plots/crop.service.ts`:
 * a `gruesa` season year is the year of its September (planted Sep–Jan, harvested
 * Feb–Jul). Finances have no campaign concept of their own, so rather than invent
 * a second definition we reuse that one: campaign <Y> spans **1 Sep Y → 31 Aug Y+1**,
 * which is the window `getSeasonYear(date, 'gruesa')` already implies.
 *
 * Keeping one definition matters — a second, subtly different "campaign" would
 * make the Resumen disagree with `campaign-stats.service.ts` for the same user.
 */
import { getSeasonYear, formatSeasonLabel } from '../domain/plots/crop.service.js';

export interface CampaignRange {
  /** Season year — the year of the campaign's September. */
  seasonYear: number;
  /** Display label, e.g. "25/26". */
  label: string;
  /** Inclusive ISO date of the first day (YYYY-09-01). */
  from: string;
  /** Inclusive ISO date of the last day (YYYY+1-08-31). */
  to: string;
}

/** The season year the given date falls into (gruesa window). */
export function currentSeasonYear(date: Date = new Date()): number {
  return getSeasonYear(date, 'gruesa');
}

export function campaignRange(seasonYear: number): CampaignRange {
  return {
    seasonYear,
    label: formatSeasonLabel(seasonYear, 'gruesa'),
    from: `${seasonYear}-09-01`,
    to: `${seasonYear + 1}-08-31`,
  };
}

/**
 * Resolve the `season` query param. Accepts a bare season year ("2025") or a
 * label ("25/26", "2025/26"). Falls back to the current campaign when absent
 * or unparseable — a bad param must never 400 the whole Resumen.
 */
export function resolveCampaign(raw: unknown, now: Date = new Date()): CampaignRange {
  if (typeof raw === 'string' && raw.trim()) {
    const head = raw.trim().split('/')[0];
    const n = parseInt(head, 10);
    if (!isNaN(n)) {
      // "25/26" → 2025; "2025" → 2025
      const year = n < 100 ? 2000 + n : n;
      if (year >= 2000 && year <= 2100) return campaignRange(year);
    }
  }
  return campaignRange(currentSeasonYear(now));
}

/**
 * The last N campaigns, newest first — for the campaign picker.
 */
export function recentCampaigns(count = 4, now: Date = new Date()): CampaignRange[] {
  const current = currentSeasonYear(now);
  const out: CampaignRange[] = [];
  for (let i = 0; i < count; i++) out.push(campaignRange(current - i));
  return out;
}
