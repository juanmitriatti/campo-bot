import { useState, useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';

export type Currency = 'ARS' | 'USD';

interface CurrencyValue {
  current: number;
  prev: number;
}

interface KpiCardProps {
  label: string;
  // Static mode: pass value (+ optional delta) directly. Used by counters
  // (e.g., Actividades) that don't depend on currency.
  value?: string;
  delta?: number | null;
  // Currency mode: pass per-currency totals.
  //   mode='toggle' (default) → small ARS/USD switch, one value at a time.
  //   mode='dual'             → both currencies stacked, no toggle.
  currencies?: Record<Currency, CurrencyValue>;
  mode?: 'toggle' | 'dual';
  tint: string; // bg color class e.g. "bg-red-50"
  Icon: LucideIcon;
  iconColor?: string;
}

function formatMoney(n: number, currency: Currency): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const symbol = currency === 'USD' ? 'USD ' : '$';
  if (abs >= 1_000_000) return `${sign}${symbol}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${symbol}${Math.round(abs / 1_000)}k`;
  return `${sign}${symbol}${new Intl.NumberFormat('es-AR').format(abs)}`;
}

function calcDelta(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? 100 : null;
  return ((current - previous) / previous) * 100;
}

function CurrencyRow({ amount, prev, currency }: { amount: number; prev: number; currency: Currency }) {
  const d = calcDelta(amount, prev);
  const dColor = d != null && d >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
  const dSign = d != null && d >= 0 ? '+' : '';
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xl font-bold text-gray-900 dark:text-gray-100">{formatMoney(amount, currency)}</span>
      {d != null && isFinite(d) && (
        <span className={`text-[11px] ${dColor}`}>
          {dSign}{Math.round(d)}%
        </span>
      )}
    </div>
  );
}

export default function KpiCard({
  label, value, delta, currencies, mode = 'toggle', tint, Icon, iconColor = 'text-gray-500',
}: KpiCardProps) {
  const isDual = mode === 'dual' && currencies;

  const defaultCurrency = useMemo<Currency>(() => {
    if (!currencies) return 'ARS';
    if (currencies.ARS.current !== 0) return 'ARS';
    if (currencies.USD.current !== 0) return 'USD';
    return 'ARS';
  }, [currencies]);

  const [currency, setCurrency] = useState<Currency>(defaultCurrency);

  // Toggle-mode display values
  let displayValue = value ?? '';
  let displayDelta: number | null | undefined = delta;
  if (currencies && !isDual) {
    const v = currencies[currency];
    displayValue = formatMoney(v.current, currency);
    displayDelta = calcDelta(v.current, v.prev);
  }

  const deltaColor = displayDelta != null && displayDelta >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
  const deltaSign = displayDelta != null && displayDelta >= 0 ? '+' : '';

  return (
    <div className={`${tint} rounded-xl border border-gray-100 dark:border-gray-700 p-5 shadow-sm`}>
      <div className="flex items-center justify-between mb-3 gap-2">
        <span className="text-sm font-medium text-gray-600 dark:text-gray-300 truncate">{label}</span>
        <div className="flex items-center gap-2 shrink-0">
          {currencies && !isDual && (
            <div className="inline-flex rounded-md border border-gray-200 dark:border-gray-600 overflow-hidden bg-white/70 dark:bg-gray-700/70 text-[10px] font-semibold">
              {(['ARS', 'USD'] as const).map(c => (
                <button
                  key={c}
                  onClick={() => setCurrency(c)}
                  className={`px-1.5 py-0.5 transition-colors ${
                    c === currency
                      ? 'bg-campo-600 text-white'
                      : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <Icon className={`w-5 h-5 ${iconColor}`} />
        </div>
      </div>

      {isDual && currencies ? (
        <div className="space-y-1.5">
          <CurrencyRow amount={currencies.ARS.current} prev={currencies.ARS.prev} currency="ARS" />
          <CurrencyRow amount={currencies.USD.current} prev={currencies.USD.prev} currency="USD" />
        </div>
      ) : (
        <>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{displayValue}</p>
          {displayDelta != null && isFinite(displayDelta) && (
            <p className={`text-xs mt-1 ${deltaColor}`}>
              {deltaSign}{Math.round(displayDelta)}% vs mes anterior
            </p>
          )}
        </>
      )}
    </div>
  );
}
