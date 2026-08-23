import { AlertTriangle } from 'lucide-react';
import type { OverviewFeedItem } from '../../hooks/useOverviewData';
import { dayMonth } from '../../utils/format';

interface Props {
  items: OverviewFeedItem[];
  activityCount: number;
  /** Feed rows a "Para revisar" finding points at, as `${type}:${id}`. */
  flagged?: Set<string>;
  onItemClick?: (type: 'expense' | 'income' | 'activity', id: number) => void;
  onSeeAll?: () => void;
}

/**
 * What the bot recorded most recently — the answer to "¿quedó cargado?".
 *
 * Rows the review rules flagged carry a marker here too, so the warning is
 * visible where the user is actually reading, not only inside its own card.
 */
export default function CampaignFeed({ items, activityCount, flagged, onItemClick, onSeeAll }: Props) {
  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Lo último que cargaste</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {activityCount} {activityCount === 1 ? 'actividad' : 'actividades'}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
          Todavía no hay nada cargado en esta campaña.
        </p>
      ) : (
        <>
          <div className="flex flex-col">
            {items.map(item => {
              const isFlagged = flagged?.has(`${item.type}:${item.id}`) ?? false;
              const clickable = Boolean(onItemClick);
              const Row = clickable ? 'button' : 'div';
              return (
                <Row
                  key={`${item.type}-${item.id}`}
                  {...(clickable ? { type: 'button' as const, onClick: () => onItemClick!(item.type, item.id) } : {})}
                  className={`flex gap-3 py-2.5 text-left border-t border-gray-100 dark:border-gray-700 first:border-t-0 ${
                    clickable ? 'hover:bg-gray-50 dark:hover:bg-gray-700/40 -mx-2 px-2 rounded transition-colors' : ''
                  }`}
                >
                  <span className="font-mono text-[11.5px] text-gray-400 dark:text-gray-500 shrink-0 w-11 pt-px tabular-nums">
                    {dayMonth(item.date)}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12.5px] leading-snug">
                      <span className="font-semibold text-gray-900 dark:text-gray-100">{item.kind}</span>
                      <span className="text-gray-600 dark:text-gray-300">{item.detail}</span>
                    </span>
                    {item.where && (
                      <span className="block text-[11.5px] text-gray-400 dark:text-gray-500 mt-0.5 truncate">
                        {item.where}
                      </span>
                    )}
                  </span>
                  {isFlagged && (
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
                  )}
                </Row>
              );
            })}
          </div>
          {onSeeAll && (
            <button
              onClick={onSeeAll}
              className="mt-3 text-xs font-semibold text-campo-700 dark:text-campo-400 hover:underline"
            >
              Ver todas →
            </button>
          )}
        </>
      )}
    </section>
  );
}
