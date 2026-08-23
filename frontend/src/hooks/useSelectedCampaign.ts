import { useEffect, useState, useCallback } from 'react';

/**
 * Reads/writes ?season=YYYY in the URL. `null` means "the current campaign",
 * which the server resolves — the frontend deliberately does not compute the
 * campaign window itself (utils/campaign-range.ts owns that definition).
 *
 * Same module-level shared-store shape as useSelectedField, for the same reason:
 * history.replaceState fires no event, so components would not see each other's
 * writes without it.
 */
function readFromUrl(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('season');
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

function writeToUrl(season: number | null) {
  const params = new URLSearchParams(window.location.search);
  if (season == null) params.delete('season');
  else params.set('season', String(season));
  const qs = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? '?' + qs : ''}${window.location.hash}`);
}

let current: number | null = readFromUrl();
const subscribers = new Set<(v: number | null) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    current = readFromUrl();
    for (const fn of subscribers) fn(current);
  });
}

export function useSelectedCampaign(): [number | null, (season: number | null) => void] {
  const [season, setLocal] = useState<number | null>(current);

  useEffect(() => {
    subscribers.add(setLocal);
    if (season !== current) setLocal(current);
    return () => { subscribers.delete(setLocal); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback((v: number | null) => {
    current = v;
    writeToUrl(v);
    for (const fn of subscribers) fn(v);
  }, []);

  return [season, set];
}
