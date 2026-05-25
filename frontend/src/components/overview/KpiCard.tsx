import type { LucideIcon } from 'lucide-react';
import { useCurrency } from '../../context/CurrencyContext';

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

/**
 * Returns null when there's no comparable previous period (avoids the misleading
 * "+100% vs mes anterior" that we showed for every metric when previous=0).
 * When there IS a base, returns the % delta as a normal number.
 */
function calcDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function CurrencyRow({ amount, prev, currency }: { amount: number; prev: number; currency: Currency }) {
  const d = calcDelta(amount, prev);
  const dColor = d != null && d >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
  const dSign = d != null && d >= 0 ? '+' : '';
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xl font-bold text-gray-900 dark:text-gray-100">{formatMoney(amount, currency)}</span>
      {d != null && isFinite(d) ? (
        <span className={`text-[11px] ${dColor}`}>{dSign}{Math.round(d)}%</span>
      ) : null}
    </div>
  );
}

export default function KpiCard({
  label, value, delta, currencies, mode = 'toggle', tint, Icon, iconColor = 'text-gray-500',
}: KpiCardProps) {
  const isDual = mode === 'dual' && currencies;
  const { currency } = useCurrency();

  // Toggle-mode display values
  let displayValue = value ?? '';
  let displayDelta: number | null | undefined = delta;
  let displayCurrent = 0; // tracks current-period numeric value for "sin base" guard
  if (currencies && !isDual) {
    const v = currencies[currency];
    displayValue = formatMoney(v.current, currency);
    displayDelta = calcDelta(v.current, v.prev);
    displayCurrent = v.current;
  }

  const deltaColor = displayDelta != null && displayDelta >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
  const deltaSign = displayDelta != null && displayDelta >= 0 ? '+' : '';
  // Only show "sin base" hint when there IS a current value worth comparing.
  // When the current period is also 0, the message is just noise.
  const showNoBaseHint = currencies && !isDual && displayDelta == null && displayCurrent !== 0;

  return (
    <div className={`${tint} dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-5 shadow-sm`}>
      <div className="flex items-center justify-between mb-3 gap-2">
        <span className="text-sm font-medium text-gray-600 dark:text-gray-300 truncate">{label}</span>
        <Icon className={`w-5 h-5 ${iconColor} shrink-0`} />
      </div>

      {isDual && currencies ? (
        <>
          <div className="space-y-1.5">
            <CurrencyRow amount={currencies.ARS.current} prev={currencies.ARS.prev} currency="ARS" />
            <CurrencyRow amount={currencies.USD.current} prev={currencies.USD.prev} currency="USD" />
          </div>
          {(() => {
            const arsBase = calcDelta(currencies.ARS.current, currencies.ARS.prev);
            const usdBase = calcDelta(currencies.USD.current, currencies.USD.prev);
            const anyValue = currencies.ARS.current !== 0 || currencies.USD.current !== 0;
            // Render the hint once at the card bottom only when neither
            // currency has comparable history.
            if (arsBase == null && usdBase == null && anyValue) {
              return <p className="text-[11px] mt-1 text-gray-400 dark:text-gray-500" title="No hay datos del mes anterior para comparar">— sin base de comparación</p>;
            }
            return null;
          })()}
        </>
      ) : (
        <>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{displayValue}</p>
          {displayDelta != null && isFinite(displayDelta) ? (
            <p className={`text-xs mt-1 ${deltaColor}`}>
              {deltaSign}{Math.round(displayDelta)}% vs mes anterior
            </p>
          ) : showNoBaseHint ? (
            <p className="text-xs mt-1 text-gray-400 dark:text-gray-500" title="No hay datos del mes anterior para comparar">— sin base de comparación</p>
          ) : null}
        </>
      )}
    </div>
  );
}
