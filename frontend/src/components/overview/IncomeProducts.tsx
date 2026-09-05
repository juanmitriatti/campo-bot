import type { IncomeProductRow } from '../../hooks/useOverviewData';
import { money, number, percent } from '../../utils/format';
import type { Currency } from '../../utils/format';

interface Props {
  rows: IncomeProductRow[];
  currency: Currency;
  onSeeAll?: () => void;
}

/**
 * What was sold — by grain (or category when the row has no product).
 *
 * The mirror of "En qué se fue la plata". The Resumen ranked expenses by
 * category and said nothing about income beyond one total, when the number a
 * grain producer actually wants is tonnes sold and the average price they got.
 * kg and $/tn only show when the rows carried a weight unit; a sale dictated
 * without a quantity still counts in the total, just not in the price.
 */
export default function IncomeProducts({ rows, currency, onSeeAll }: Props) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  const top = rows.length ? rows[0].total : 1;

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Qué vendiste</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {rows.length > 0 ? `${currency} · ${percent(rows[0].total, total)}% en ${rows[0].name.toLowerCase()}` : currency}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No hay ingresos en {currency} en esta campaña.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {rows.map((r, i) => (
            <div key={r.name} className="grid grid-cols-[minmax(72px,1fr)_2fr_auto] sm:grid-cols-[108px_1fr_104px] items-center gap-3">
              <span className="min-w-0">
                <span className="block text-xs text-gray-600 dark:text-gray-300 truncate" title={r.name}>{r.name}</span>
                {(r.kg != null && r.kg > 0) && (
                  <span className="block text-[11px] text-gray-400 dark:text-gray-500 tabular-nums truncate">
                    {number(r.kg / 1000)} tn
                    {r.pricePerTn != null && ` · ${money(r.pricePerTn, currency)}/tn`}
                  </span>
                )}
              </span>
              <div className="h-3.5 rounded bg-gray-100 dark:bg-gray-700 overflow-hidden">
                <div
                  className={`h-full rounded ${i === 0 ? 'bg-campo-700 dark:bg-campo-400' : 'bg-campo-400 dark:bg-campo-700'}`}
                  style={{ width: `${Math.max(2, Math.round((r.total / top) * 100))}%` }}
                />
              </div>
              <span className="font-mono text-xs font-semibold text-right text-gray-900 dark:text-gray-100 tabular-nums">
                {money(r.total, currency)}
              </span>
            </div>
          ))}
        </div>
      )}

      {onSeeAll && rows.length > 0 && (
        <button
          onClick={onSeeAll}
          className="mt-3 text-xs font-semibold text-campo-700 dark:text-campo-400 hover:underline"
        >
          Ver ingresos →
        </button>
      )}
    </section>
  );
}
