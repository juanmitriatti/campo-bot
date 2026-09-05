import { Beef } from 'lucide-react';
import type { LivestockSummary } from '../../hooks/useOverviewData';
import { number, dayMonth } from '../../utils/format';

interface Props {
  data: LivestockSummary;
  onSeeAll?: () => void;
}

/**
 * The herd, on the Resumen.
 *
 * A livestock-only user opened the Resumen and saw a campaign result of zero
 * pesos and a banner; the rodeo itself was two clicks away. Head by category
 * and the last weighing are enough to know the number is still the number.
 * Rendered only when there is hacienda in the selected fields.
 */
export default function LivestockCard({ data, onSeeAll }: Props) {
  if (data.total <= 0) return null;
  const max = Math.max(...data.byCategory.map(c => c.count), 1);

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <Beef className="w-4 h-4 text-amber-600 dark:text-amber-500 shrink-0" />
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Hacienda</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
          {data.byCategory.length} {data.byCategory.length === 1 ? 'categoría' : 'categorías'}
        </span>
      </div>

      <div className="flex items-baseline gap-2 mt-1 mb-3">
        <span className="font-mono text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
          {number(data.total)}
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500">cabezas</span>
      </div>

      <div className="flex flex-col gap-2">
        {data.byCategory.map(c => (
          <div key={c.category} className="grid grid-cols-[96px_1fr_56px] items-center gap-3">
            <span className="text-xs text-gray-600 dark:text-gray-300 truncate" title={c.category}>{c.category}</span>
            <div className="h-3 rounded bg-gray-100 dark:bg-gray-700 overflow-hidden">
              <div
                className="h-full rounded bg-amber-500 dark:bg-amber-400"
                style={{ width: `${Math.max(2, Math.round((c.count / max) * 100))}%` }}
              />
            </div>
            <span className="font-mono text-xs font-semibold text-right text-gray-900 dark:text-gray-100 tabular-nums">
              {number(c.count)}
            </span>
          </div>
        ))}
      </div>

      <p className="text-[11.5px] text-gray-400 dark:text-gray-500 mt-3 leading-snug">
        {data.lastWeighing
          ? `Último pesaje: ${number(data.lastWeighing.kg)} kg${data.lastWeighing.category ? ` (${data.lastWeighing.category})` : ''} · ${dayMonth(data.lastWeighing.date)}`
          : 'Sin pesajes registrados.'}
      </p>

      {onSeeAll && (
        <button onClick={onSeeAll} className="mt-2 text-xs font-semibold text-campo-700 dark:text-campo-400 hover:underline">
          Ver hacienda →
        </button>
      )}
    </section>
  );
}
