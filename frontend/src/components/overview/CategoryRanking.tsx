import type { CategoryRow } from '../../hooks/useOverviewData';
import { money, percent } from '../../utils/format';
import type { Currency } from '../../utils/format';

interface Props {
  rows: CategoryRow[];
  currency: Currency;
}

/**
 * Where the money went — ranked bars, one hue.
 *
 * This replaced a 10-slice donut. Spend by category is a MAGNITUDE comparison,
 * not an identity one: ten hues encoded nothing the label wasn't already saying,
 * and a donut makes "is Combustible bigger than Insumos?" harder than a sorted
 * bar does. The largest row is emphasised because it usually explains the total.
 */
export default function CategoryRanking({ rows, currency }: Props) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  const top = rows.length ? rows[0].total : 1;

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">En qué se fue la plata</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {rows.length > 0 ? `${currency} · ${percent(rows[0].total, total)}% en ${rows[0].category.toLowerCase()}` : currency}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No hay gastos en {currency} en esta campaña.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {rows.map((r, i) => (
            <div key={r.category} className="grid grid-cols-[minmax(72px,1fr)_2fr_auto] sm:grid-cols-[108px_1fr_104px] items-center gap-3">
              <span className="text-xs text-gray-600 dark:text-gray-300 truncate" title={r.category}>
                {r.category}
              </span>
              <div className="h-3.5 rounded bg-gray-100 dark:bg-gray-700 overflow-hidden">
                <div
                  className={`h-full rounded ${i === 0 ? 'bg-gray-800 dark:bg-gray-200' : 'bg-gray-400 dark:bg-gray-500'}`}
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
    </section>
  );
}
