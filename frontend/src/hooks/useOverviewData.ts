import { useEffect, useState, useCallback } from 'react';
import { apiRequest } from '../api/client';

export interface MoneySide {
  income: number;
  expense: number;
  result: number;
  incomeCount: number;
  expenseCount: number;
}

export interface CategoryRow {
  category: string;
  total: number;
}

export interface OverviewPlot {
  id: number;
  name: string;
  fieldId: number;
  fieldName: string;
  areaHectares: number | null;
  crop: string | null;
  cropState: string | null;
  spendARS: number;
  spendUSD: number;
  incomeARS: number;
  incomeUSD: number;
  lastActivity: string | null;
}

export interface OverviewFeedItem {
  type: 'expense' | 'income' | 'activity';
  id: number;
  date: string;
  kind: string;
  detail: string;
  where: string | null;
}

export interface CampaignRef {
  seasonYear: number;
  label: string;
  from?: string;
  to?: string;
}

export interface OverviewCounts {
  plots: number;
  activities: number;
  scoutings: number;
  harvests: number;
  expenses: number;
  incomes: number;
  stock: number;
  stockAlerts: number;
  livestock: number;
  documents: number;
  reminders: number;
}

export interface OverviewData {
  campaign: CampaignRef & { from: string; to: string };
  counts: OverviewCounts;
  campaigns: CampaignRef[];
  observed: { from: string | null; to: string | null };
  money: { ARS: MoneySide; USD: MoneySide };
  categories: { ARS: CategoryRow[]; USD: CategoryRow[] };
  rainfall: { total: number; count: number; months: Array<{ month: string; label: string; mm: number }> };
  activities: { count: number };
  plots: OverviewPlot[];
  feed: OverviewFeedItem[];
}

interface Entry {
  data: OverviewData | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: Entry = { data: null, loading: true, error: null };

/**
 * Module-level cache keyed by (field, season), shared by every consumer.
 *
 * The Resumen and the sidebar both need this payload — the sidebar only for its
 * per-section counters. Without a shared store they would each fire their own
 * request on every field change; this mirrors what `useSelectedField` already
 * does for the selected field.
 */
const cache = new Map<string, Entry>();
const subscribers = new Map<string, Set<(e: Entry) => void>>();
const inFlight = new Set<string>();

function keyFor(fieldId: number | null, season: number | null): string {
  return `${fieldId ?? 'all'}|${season ?? 'current'}`;
}

function emit(key: string, entry: Entry) {
  cache.set(key, entry);
  const subs = subscribers.get(key);
  if (subs) for (const fn of subs) fn(entry);
}

async function load(key: string, fieldId: number | null, season: number | null, force = false) {
  if (inFlight.has(key)) return;
  if (!force && cache.get(key)?.data) return;
  inFlight.add(key);
  emit(key, { data: cache.get(key)?.data ?? null, loading: true, error: null });
  try {
    const qs = new URLSearchParams();
    qs.set('field_id', fieldId == null ? 'all' : String(fieldId));
    if (season != null) qs.set('season', String(season));
    const data = await apiRequest<OverviewData>(`/overview?${qs.toString()}`);
    emit(key, { data, loading: false, error: null });
  } catch (err) {
    emit(key, {
      data: null,
      loading: false,
      error: err instanceof Error ? err.message : 'No se pudo cargar el resumen',
    });
  } finally {
    inFlight.delete(key);
  }
}

/** Drop every cached page — call after a mutation that changes the numbers. */
export function invalidateOverview() {
  const keys = Array.from(cache.keys());
  cache.clear();
  for (const key of keys) {
    const subs = subscribers.get(key);
    if (subs) for (const fn of subs) fn(EMPTY);
  }
}

export function useOverviewData(fieldId: number | null, season: number | null) {
  const key = keyFor(fieldId, season);
  const [entry, setEntry] = useState<Entry>(() => cache.get(key) ?? EMPTY);

  useEffect(() => {
    let subs = subscribers.get(key);
    if (!subs) {
      subs = new Set();
      subscribers.set(key, subs);
    }
    subs.add(setEntry);
    setEntry(cache.get(key) ?? EMPTY);
    void load(key, fieldId, season);
    return () => {
      subs!.delete(setEntry);
      if (subs!.size === 0) subscribers.delete(key);
    };
  }, [key, fieldId, season]);

  const refresh = useCallback(() => load(key, fieldId, season, true), [key, fieldId, season]);

  return { data: entry.data, loading: entry.loading, error: entry.error, refresh };
}
