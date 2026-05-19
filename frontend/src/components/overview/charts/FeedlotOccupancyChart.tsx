import type { FeedlotOccupancyRow } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: FeedlotOccupancyRow[]; }

function occupancyColor(pct: number): string {
  if (pct >= 95) return 'bg-red-500';
  if (pct >= 80) return 'bg-amber-500';
  return 'bg-green-500';
}

export default function FeedlotOccupancyChart({ data }: Props) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Ocupación de corrales</h3>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-12">Sin corrales.</p>
      ) : (
        <ul className="space-y-2 max-h-56 overflow-y-auto">
          {data.map(c => {
            const pct = c.capacity && c.capacity > 0
              ? Math.min(100, (c.currentHeadcount / c.capacity) * 100)
              : null;
            return (
              <li key={c.corralId} className="text-xs">
                <div className="flex justify-between mb-0.5">
                  <span className="font-medium text-gray-700 truncate">{c.corralName}</span>
                  <span className="text-gray-500">
                    {c.currentHeadcount}{c.capacity != null && ` / ${c.capacity}`}{pct != null && ` · ${Math.round(pct)}%`}
                  </span>
                </div>
                {pct != null && (
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full ${occupancyColor(pct)}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
