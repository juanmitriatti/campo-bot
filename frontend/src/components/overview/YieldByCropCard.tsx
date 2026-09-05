import type { YieldByCropRow } from '../../hooks/useAgronomicAnalyticsData';
import { number } from '../../utils/format';

interface Props {
  rows: YieldByCropRow[];
  campaignLabel?: string;
}

/**
 * Average yield per crop in the campaign — ranked bars, one hue.
 *
 * Computed by the endpoint since the agronomic tab was built and never drawn.
 * Yield is the number a producer quotes first, so it gets a card, not a
 * tooltip on a scatter point.
 */
export default function YieldByCropCard({ rows, campaignLabel }: Props) {
  const withYield = rows.filter(r => r.avgKgPerHa != null && r.avgKgPerHa > 0);
  const top = withYield.length ? (withYield[0].avgKgPerHa as number) : 1;

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Rinde por cultivo</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">kg/ha · promedio{campaignLabel ? ` · ${campaignLabel}` : ''}</span>
      </div>

      {withYield.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed max-w-prose">
          Sin cosechas con rinde en esta campaña. Hace falta la cantidad cosechada (o los camiones) y la
          superficie del lote para calcularlo.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {withYield.map((r, i) => (
            <div key={r.crop} className="grid grid-cols-[minmax(72px,1fr)_2fr_auto] sm:grid-cols-[108px_1fr_104px] items-center gap-3">
              <span className="min-w-0">
                <span className="block text-xs text-gray-600 dark:text-gray-300 truncate" title={r.crop}>{r.crop}</span>
                <span className="block text-[11px] text-gray-400 dark:text-gray-500">
                  {r.harvests} {r.harvests === 1 ? 'cosecha' : 'cosechas'}
                </span>
              </span>
              <div className="h-3.5 rounded bg-gray-100 dark:bg-gray-700 overflow-hidden">
                <div
                  className={`h-full rounded ${i === 0 ? 'bg-amber-600 dark:bg-amber-400' : 'bg-amber-400 dark:bg-amber-700'}`}
                  style={{ width: `${Math.max(2, Math.round(((r.avgKgPerHa as number) / top) * 100))}%` }}
                />
              </div>
              <span className="font-mono text-xs font-semibold text-right text-gray-900 dark:text-gray-100 tabular-nums">
                {number(r.avgKgPerHa as number)} kg/ha
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
