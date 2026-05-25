import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

export type Currency = 'ARS' | 'USD';

interface CurrencyContextValue {
  currency: Currency;
  setCurrency: (c: Currency) => void;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

const STORAGE_KEY = 'campo:currency';

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<Currency>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    return saved === 'USD' ? 'USD' : 'ARS';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, currency);
  }, [currency]);

  const setCurrency = (c: Currency) => setCurrencyState(c);

  return <CurrencyContext.Provider value={{ currency, setCurrency }}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) {
    // Safe fallback so charts can still render outside the provider.
    return { currency: 'ARS', setCurrency: () => {} };
  }
  return ctx;
}
