import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';

export type Severity = 'warn' | 'info';

export interface Finding {
  key: string;
  rule: string;
  severity: Severity;
  title: string;
  body: string;
  action: string;
  ref: { type: 'activity' | 'expense' | 'plot' | 'field'; id: number } | null;
  fieldId: number | null;
}

const DISMISS_KEY = 'campo:reviewDismissed';

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(set: Set<string>) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(Array.from(set)));
  } catch { /* private mode: dismissals just don't persist */ }
}

/**
 * "Para revisar" findings, minus the ones this user already waved off.
 *
 * Dismissals live in localStorage, not the DB: a finding is a derived opinion,
 * not a record — if the underlying data is fixed the finding disappears on its
 * own, and if the user dismisses one on another device it is fine for it to
 * come back there. Nothing here mutates anything server-side.
 */
export function useReviewFindings(fieldId: number | null, season: number | null) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('field_id', fieldId == null ? 'all' : String(fieldId));
      if (season != null) qs.set('season', String(season));
      const res = await apiRequest<{ findings: Finding[] }>(`/review?${qs.toString()}`);
      setFindings(res.findings ?? []);
    } catch (err) {
      // Advisory panel: a failure hides the card, it never breaks the Resumen.
      setError(err instanceof Error ? err.message : 'No se pudo cargar la revisión');
      setFindings([]);
    } finally {
      setLoading(false);
    }
  }, [fieldId, season]);

  useEffect(() => { void refresh(); }, [refresh]);

  const dismiss = useCallback((key: string) => {
    setDismissed(prev => {
      const next = new Set(prev);
      next.add(key);
      writeDismissed(next);
      return next;
    });
  }, []);

  const restoreAll = useCallback(() => {
    setDismissed(new Set());
    writeDismissed(new Set());
  }, []);

  const visible = findings.filter(f => !dismissed.has(f.key));
  const hiddenCount = findings.length - visible.length;

  return { findings: visible, hiddenCount, loading, error, dismiss, restoreAll, refresh };
}
