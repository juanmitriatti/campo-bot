import { useState, useEffect, useCallback } from 'react';

export type OverviewTab = 'resumen' | 'agronomico' | 'ganadero';

const VALID_TABS: ReadonlyArray<OverviewTab> = ['resumen', 'agronomico', 'ganadero'];

function readTabFromUrl(): OverviewTab {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('overview');
  if (raw && (VALID_TABS as ReadonlyArray<string>).includes(raw)) {
    return raw as OverviewTab;
  }
  return 'resumen';
}

function writeTabToUrl(tab: OverviewTab) {
  const params = new URLSearchParams(window.location.search);
  if (tab === 'resumen') {
    params.delete('overview');
  } else {
    params.set('overview', tab);
  }
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? '?' + qs : ''}${window.location.hash}`;
  window.history.replaceState(null, '', next);
}

export function useOverviewTab(): [OverviewTab, (tab: OverviewTab) => void] {
  const [tab, setTabState] = useState<OverviewTab>(readTabFromUrl);

  // Keep state synced with browser back/forward navigation
  useEffect(() => {
    const onPop = () => setTabState(readTabFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const setTab = useCallback((next: OverviewTab) => {
    setTabState(next);
    writeTabToUrl(next);
  }, []);

  return [tab, setTab];
}
