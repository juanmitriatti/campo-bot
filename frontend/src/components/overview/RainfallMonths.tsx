import { number } from '../../utils/format';

interface Month {
  month: string;
  label: string;
  mm: number;
}

interface Props {
  total: number;
  count: number;
  months: Month[];
  /** Same twelve months, one campaign earlier. */
  prevTotal?: number;
  prevMonths?: Month[];
  prevLabel?: string;
}

/**
 * Rainfall across the campaign, one bar per month, with the previous campaign
 * as a thin grey bar beside it.
 *
 * Every month of the window is rendered, including the empty ones: a month with
 * no records is the single most useful thing this chart can show (rain that fell
 * and was never dictated to the bot), and dropping it from the axis hides it.
 * The previous campaign gives the number a reference: 400 mm means nothing
 * until you know last year's November had 120 and this one has 40.
 */
export default function RainfallMonths({ total, count, months, prevTotal = 0, prevMonths = [], prevLabel }: Props) {
  const prevByMonth = new Map(prevMonths.map(m => [m.month.slice(5, 7), m.mm]));
  const hasPrev = prevTotal > 0;
  const max = Math.max(...months.map(m => m.mm), ...(hasPrev ? prevMonths.map(m => m.mm) : []), 1);
  const withData = months.filter(m => m.mm > 0);
  const gaps = months.length - withData.length;
  const delta = hasPrev ? total - prevTotal : null;

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 flex flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Lluvia acumulada</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {count} {count === 1 ? 'registro' : 'registros'}
        </span>
      </div>

      <div className="flex items-baseline gap-2 mt-2 mb-4 flex-wrap">
        <span className="font-mono text-2xl font-semibold tracking-tight text-blue-700 dark:text-blue-400">
          {number(total)}
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500">mm en la campaña</span>
        {delta != null && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            · {delta >= 0 ? '+' : '−'}{number(Math.abs(delta))} mm vs. {prevLabel ?? 'campaña anterior'} ({number(prevTotal)} mm)
          </span>
        )}
      </div>

      <div className="flex items-end gap-1.5 h-24 border-b border-gray-200 dark:border-gray-700 pb-0.5">
        {months.map(m => {
          const prev = hasPrev ? (prevByMonth.get(m.month.slice(5, 7)) ?? 0) : 0;
          return (
            <div key={m.month} className="flex-1 min-w-0 flex flex-col items-center gap-1 justify-end">
              <span className="font-mono text-[10px] font-semibold text-gray-400 dark:text-gray-500 tabular-nums">
                {m.mm > 0 ? number(m.mm) : ''}
              </span>
              <div className="w-full flex items-end gap-px">
                <div
                  title={`${m.label}: ${number(m.mm)} mm`}
                  className={`flex-[3] rounded-t ${m.mm > 0 ? 'bg-blue-600 dark:bg-blue-500' : 'bg-gray-100 dark:bg-gray-700'}`}
                  style={{ height: `${Math.max(2, Math.round((m.mm / max) * 68))}px` }}
                />
                {hasPrev && (
                  <div
                    title={`${m.label} ${prevLabel ?? 'anterior'}: ${number(prev)} mm`}
                    className={`flex-[2] rounded-t ${prev > 0 ? 'bg-gray-300 dark:bg-gray-600' : 'bg-gray-100 dark:bg-gray-700'}`}
                    style={{ height: `${Math.max(2, Math.round((prev / max) * 68))}px` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5 mt-1.5">
        {months.map(m => (
          <span key={m.month} className="flex-1 min-w-0 text-center text-[10px] text-gray-400 dark:text-gray-500">
            {m.label}
          </span>
        ))}
      </div>

      {hasPrev && (
        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2 flex items-center gap-3">
          <span className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-600 dark:bg-blue-500" /> esta campaña</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-300 dark:bg-gray-600" /> {prevLabel ?? 'campaña anterior'}</span>
        </p>
      )}

      {gaps > 0 && total > 0 && (
        <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed mt-3 text-pretty">
          {gaps === 1
            ? 'Hay un mes sin ningún registro de lluvia.'
            : `Hay ${gaps} meses sin ningún registro de lluvia.`}{' '}
          Si llovió y no se cargó, el acumulado de la campaña queda corto.
        </p>
      )}
      {total === 0 && (
        <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed mt-3">
          No hay lluvias cargadas en esta campaña. Decile al bot «llovieron 20 mm» y aparecen acá.
        </p>
      )}
    </section>
  );
}
