import type { FeedlotOccupancyRow } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: FeedlotOccupancyRow[]; }

function occupancyColor(pct: number): string {
  if (pct >= 95) return 'bg-red-500';
  if (pct >= 80) return 'bg-amber-500';
  return 'bg-green-500';
}

function occupancyLabel(pct: number): { text: string; color: string } {
  if (pct >= 95) return { text: 'Lleno', color: 'text-red-600' };
  if (pct >= 80) return { text: 'Alto', color: 'text-amber-600' };
  if (pct > 0) return { text: 'Disponible', color: 'text-green-600' };
  return { text: 'Vacío', color: 'text-gray-400' };
}

export default function FeedlotOccupancyChart({ data }: Props) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Ocupación de corrales</h3>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-300 text-center py-12">Sin corrales.</p>
      ) : (
        <ul className="space-y-3 max-h-56 overflow-y-auto pr-1">
          {data.map(c => {
            const headcount = c.currentHeadcount;
            const hasCapacity = c.capacity != null && c.capacity > 0;
            const pct = hasCapacity ? Math.min(100, (headcount / c.capacity!) * 100) : 0;
            // Status only meaningful when we know capacity. Otherwise use a
            // simpler "ocupado/vacío" label so we don't lie with a 100% bar.
            const status = hasCapacity
              ? occupancyLabel(pct)
              : (headcount > 0
                  ? { text: 'Ocupado', color: 'text-blue-600' }
                  : { text: 'Vacío', color: 'text-gray-400' });
            const subtitle = c.feedlotName
              ? `${c.feedlotName}${c.fieldName ? ` · ${c.fieldName}` : ''}`
              : (c.fieldName ?? '');

            return (
              <li key={c.corralId}>
                {/* Header row: corral name + subtitle (feedlot/field) */}
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                      Corral {c.corralName}
                    </span>
                    {subtitle && (
                      <span className="text-[11px] text-gray-400 dark:text-gray-400 ml-1.5 truncate">
                        — {subtitle}
                      </span>
                    )}
                  </div>
                  <span className={`text-[11px] font-medium ${status.color} shrink-0`}>{status.text}</span>
                </div>

                {/* Bar only when we have real capacity to compare against */}
                {hasCapacity && (
                  <div className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div className={`h-full ${occupancyColor(pct)} transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                )}

                {/* Footer row: cabezas + animal description */}
                <div className="flex items-baseline justify-between mt-1 gap-2">
                  <span className="text-[11px] text-gray-500 dark:text-gray-300 truncate flex-1 min-w-0">
                    {c.animalsDescription || 'Sin animales'}
                  </span>
                  <span className="text-[11px] text-gray-600 dark:text-gray-200 font-semibold shrink-0 tabular-nums">
                    {hasCapacity
                      ? `${headcount} / ${c.capacity} cab · ${Math.round(pct)}%`
                      : (headcount > 0 ? `${headcount} cab` : 'Vacío')}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
