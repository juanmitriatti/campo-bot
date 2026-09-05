import type { ScoutingByPlot } from '../../hooks/useAgronomicAnalyticsData';
import { dayMonth } from '../../utils/format';

interface Props {
  rows: ScoutingByPlot[];
}

const SEVERITY_LABEL = ['', 'ausente', 'leve', 'moderada', 'alta', 'severa'];

function severityClass(s: number | null): string {
  if (s == null) return 'text-gray-400 dark:text-gray-500';
  if (s >= 4) return 'text-red-700 dark:text-red-400 font-semibold';
  if (s === 3) return 'text-amber-700 dark:text-amber-400 font-semibold';
  return 'text-gray-700 dark:text-gray-300';
}

/**
 * The latest monitoreo on each lote: weed cover, pest and its severity.
 *
 * Sorted worst-first so the lote that needs a walk is at the top. A lote with
 * no scouting at all is simply absent — the Resumen already says which lotes
 * have no activity.
 */
export default function ScoutingByPlotCard({ rows }: Props) {
  if (rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => {
    const sa = a.pestSeverity1to5 ?? 0;
    const sb = b.pestSeverity1to5 ?? 0;
    if (sb !== sa) return sb - sa;
    return (b.weedCoveragePct ?? 0) - (a.weedCoveragePct ?? 0);
  });

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Estado sanitario por lote</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">último monitoreo de cada lote</span>
      </div>

      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs min-w-[560px]">
          <thead>
            <tr className="text-[11px] text-gray-400 dark:text-gray-500">
              <th className="text-left font-medium px-1 pb-2">Lote</th>
              <th className="text-left font-medium px-1 pb-2">Plaga</th>
              <th className="text-left font-medium px-1 pb-2">Presión</th>
              <th className="text-right font-medium px-1 pb-2">Malezas</th>
              <th className="text-right font-medium px-1 pb-2">Fecha</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.plotId} className="border-t border-gray-100 dark:border-gray-700">
                <td className="px-1 py-2">
                  <span className="font-semibold text-gray-900 dark:text-gray-100">{r.plotName}</span>
                  <span className="block text-[11px] text-gray-400 dark:text-gray-500">{r.fieldName}</span>
                </td>
                <td className="px-1 py-2 text-gray-700 dark:text-gray-300">{r.pestSpecies ?? '—'}</td>
                <td className={`px-1 py-2 ${severityClass(r.pestSeverity1to5)}`}>
                  {r.pestSeverity1to5 != null ? SEVERITY_LABEL[r.pestSeverity1to5] ?? r.pestSeverity1to5 : '—'}
                </td>
                <td className="px-1 py-2 text-right font-mono tabular-nums text-gray-700 dark:text-gray-300">
                  {r.weedCoveragePct != null ? `${Math.round(r.weedCoveragePct)}%` : '—'}
                  {r.weedSpecies.length > 0 && (
                    <span className="block text-[11px] font-sans text-gray-400 dark:text-gray-500 truncate max-w-[180px] ml-auto">
                      {r.weedSpecies.join(', ')}
                    </span>
                  )}
                </td>
                <td className="px-1 py-2 text-right font-mono tabular-nums text-gray-400 dark:text-gray-500">
                  {dayMonth(r.scoutedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
