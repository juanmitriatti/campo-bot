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
import { getNowArgentina } from './date.js';

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

/**
 * The season year the given date falls into (gruesa window).
 *
 * Defaults to Argentina's wall clock, not the server's: on a UTC host the
 * campaign flipped at 21:00 of 31 Aug in Buenos Aires, three hours early.
 */
export function currentSeasonYear(date: Date = getNowArgentina()): number {
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
export function resolveCampaign(raw: unknown, now: Date = getNowArgentina()): CampaignRange {
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
 * The last N campaigns, newest first — regardless of data. Kept for callers
 * that need a fixed window; the picker uses `campaignsSince` instead.
 */
export function recentCampaigns(count = 4, now: Date = getNowArgentina()): CampaignRange[] {
  const current = currentSeasonYear(now);
  const out: CampaignRange[] = [];
  for (let i = 0; i < count; i++) out.push(campaignRange(current - i));
  return out;
}

/** Hard cap on how far back the picker lists, even with ancient data. */
export const MAX_PICKER_CAMPAIGNS = 10;

/**
 * Campaigns for the picker: the current one, plus every earlier campaign back
 * to the one holding the user's OLDEST record. With no data at all, only the
 * current campaign — a picker with "22/23, 23/24, 24/25" for a user who
 * signed up last week is three empty views (prod feedback, Sep 2026).
 *
 * `earliest` is an ISO date (or Date) of the oldest expense/income/event/rain;
 * `pinned` is a season the caller must keep in the list (the one selected in
 * the URL, even if it is older than any data). Newest first.
 */
export function campaignsSince(
  earliest: string | Date | null | undefined,
  opts: { pinned?: number | null; now?: Date } = {},
): CampaignRange[] {
  const now = opts.now ?? getNowArgentina();
  const current = currentSeasonYear(now);
  let oldest = current;
  if (earliest) {
    const d = typeof earliest === 'string' ? new Date(`${earliest.slice(0, 10)}T12:00:00Z`) : earliest;
    if (!Number.isNaN(d.getTime())) oldest = Math.min(oldest, getSeasonYear(d, 'gruesa'));
  }
  if (opts.pinned != null && Number.isFinite(opts.pinned)) oldest = Math.min(oldest, opts.pinned);
  oldest = Math.max(oldest, current - (MAX_PICKER_CAMPAIGNS - 1));
  const out: CampaignRange[] = [];
  for (let y = current; y >= oldest; y--) out.push(campaignRange(y));
  return out;
}
