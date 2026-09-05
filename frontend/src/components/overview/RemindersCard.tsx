import { Clock } from 'lucide-react';
import type { ReminderRow } from '../../hooks/useOverviewData';
import { dayMonth } from '../../utils/format';

interface Props {
  overdue: number;
  upcoming: number;
  rows: ReminderRow[];
  onSeeAll?: () => void;
}

/**
 * Open tasks: overdue first, then the next seven days.
 *
 * The nav badge only said "5 recordatorios". Which five, and whether any of
 * them were already late, needed a click. This is the answer to "¿qué tengo
 * que hacer?" on the screen the user opens first.
 */
export default function RemindersCard({ overdue, upcoming, rows, onSeeAll }: Props) {
  if (rows.length === 0) return null;

  return (
    <section className={`border rounded-xl p-5 ${
      overdue > 0
        ? 'bg-amber-50/60 dark:bg-amber-900/10 border-amber-200 dark:border-amber-900'
        : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'
    }`}>
      <div className="flex items-center gap-2 mb-3">
        <Clock className={`w-4 h-4 shrink-0 ${overdue > 0 ? 'text-amber-600 dark:text-amber-500' : 'text-gray-400 dark:text-gray-500'}`} />
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Pendientes</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
          {overdue > 0 && <span className="text-amber-700 dark:text-amber-400 font-semibold">{overdue} {overdue === 1 ? 'vencido' : 'vencidos'}</span>}
          {overdue > 0 && upcoming > 0 && ' · '}
          {upcoming > 0 && `${upcoming} en los próximos 7 días`}
        </span>
      </div>

      <div className="flex flex-col">
        {rows.map(r => (
          <div key={r.id} className="flex gap-3 py-2 border-t border-gray-100 dark:border-gray-700 first:border-t-0">
            <span className={`font-mono text-[11.5px] shrink-0 w-11 pt-px tabular-nums ${
              r.overdue ? 'text-amber-700 dark:text-amber-400 font-semibold' : 'text-gray-400 dark:text-gray-500'
            }`}>
              {dayMonth(r.dueDate)}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[12.5px] leading-snug text-gray-900 dark:text-gray-100">{r.description}</span>
              {r.where && (
                <span className="block text-[11.5px] text-gray-400 dark:text-gray-500 mt-0.5 truncate">{r.where}</span>
              )}
            </span>
          </div>
        ))}
      </div>

      {onSeeAll && (
        <button onClick={onSeeAll} className="mt-3 text-xs font-semibold text-campo-700 dark:text-campo-400 hover:underline">
          Ver recordatorios →
        </button>
      )}
    </section>
  );
}
