import { useEffect, useState, useCallback } from 'react';

function readFieldFromUrl(): number | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('field_id');
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

function writeFieldToUrl(fieldId: number | null) {
  const params = new URLSearchParams(window.location.search);
  if (fieldId == null) params.delete('field_id');
  else params.set('field_id', String(fieldId));
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? '?' + qs : ''}${window.location.hash}`;
  window.history.replaceState(null, '', next);
}

// Module-level shared state so every useSelectedField() consumer reads/writes
// the same value. Without this, Sidebar + OverviewPage each had their own
// local React state — when one called setFieldId, the other never re-rendered
// because history.replaceState does not fire a popstate event.
let currentFieldId: number | null = typeof window !== 'undefined' ? readFieldFromUrl() : null;
const subscribers = new Set<(id: number | null) => void>();

function setShared(id: number | null) {
  currentFieldId = id;
  writeFieldToUrl(id);
  for (const fn of subscribers) fn(id);
}

if (typeof window !== 'undefined') {
  // Keep shared state in sync with back/forward navigation as well.
  window.addEventListener('popstate', () => {
    const fromUrl = readFieldFromUrl();
    currentFieldId = fromUrl;
    for (const fn of subscribers) fn(fromUrl);
  });
}

/**
 * Reads/writes ?field_id=N in the URL. Returns null until a field is selected.
 * Setter accepts null → "Todos los campos".
 *
 * All consumers share a single source of truth so changing the field in one
 * component (e.g. sidebar selector) propagates to every other component that
 * consumes the value (e.g. overview, analytics hooks).
 */
export function useSelectedField(): [number | null, (id: number | null) => void] {
  const [fieldId, setFieldIdLocal] = useState<number | null>(currentFieldId);

  useEffect(() => {
    subscribers.add(setFieldIdLocal);
    // In case state changed between render and effect mount.
    if (fieldId !== currentFieldId) setFieldIdLocal(currentFieldId);
    return () => {
      subscribers.delete(setFieldIdLocal);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setFieldId = useCallback((id: number | null) => {
    setShared(id);
  }, []);

  return [fieldId, setFieldId];
}
