import { useState, useEffect, useCallback } from 'react';

function readFieldFromUrl(): number | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('field_id');
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

function writeFieldToUrl(fieldId: number) {
  const params = new URLSearchParams(window.location.search);
  params.set('field_id', String(fieldId));
  const qs = params.toString();
  const next = `${window.location.pathname}?${qs}${window.location.hash}`;
  window.history.replaceState(null, '', next);
}

/**
 * Reads/writes ?field_id=N in the URL. Returns null until a field is selected.
 * The caller is responsible for picking a default (e.g. first field alphabetically)
 * once the user's field list has loaded.
 */
export function useSelectedField(): [number | null, (id: number) => void] {
  const [fieldId, setFieldIdState] = useState<number | null>(readFieldFromUrl);

  useEffect(() => {
    const onPop = () => setFieldIdState(readFieldFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const setFieldId = useCallback((id: number) => {
    setFieldIdState(id);
    writeFieldToUrl(id);
  }, []);

  return [fieldId, setFieldId];
}
