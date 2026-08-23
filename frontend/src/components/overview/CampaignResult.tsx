import type { MoneySide } from '../../hooks/useOverviewData';
import { money, signedMoney, dateRange, percent } from '../../utils/format';
import type { Currency } from '../../utils/format';

interface Props {
  money: { ARS: MoneySide; USD: MoneySide };
  topCategory: { ARS: { category: string; total: number } | null; USD: { category: string; total: number } | null };
  observed: { from: string | null; to: string | null };
  campaignLabel: string;
}

/**
 * The campaign result, in BOTH currencies at once.
 *
 * Deliberately not a currency toggle: an Argentine farm is routinely negative in
 * pesos and positive in dollars in the same campaign (costs in ARS, grain sold in
 * USD). Showing one at a time and calling it "el resultado" is simply wrong, so
 * both sit side by side and neither is the headline.
 */
export default function CampaignResult({ money: m, topCategory, observed, campaignLabel }: Props) {
  const sides: Array<{ key: Currency; head: string; side: MoneySide }> = [
    { key: 'USD', head: 'En dólares', side: m.USD },
    { key: 'ARS', head: 'En pesos', side: m.ARS },
  ];

  const hasAny = m.ARS.expenseCount + m.ARS.incomeCount + m.USD.expenseCount + m.USD.incomeCount > 0;
  const counts = [
    m.ARS.expenseCount + m.USD.expenseCount,
    m.ARS.incomeCount + m.USD.incomeCount,
  ];

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Resultado de campaña <span className="text-gray-400 dark:text-gray-500 font-normal">{campaignLabel}</span>
        </h2>
        {hasAny && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {dateRange(observed.from, observed.to)} · {counts[0]} gastos · {counts[1]} ingresos
          </span>
        )}
      </div>

      {!hasAny ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed max-w-prose">
          No hay gastos ni ingresos cargados en esta campaña para la selección actual.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {sides.map(({ key, head, side }) => {
            const span = Math.max(side.income, side.expense, 1);
            const positive = side.result >= 0;
            const top = topCategory[key];
            return (
              <div key={key} className="bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700 rounded-lg p-4">
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-1.5">{head}</p>
                <p className={`font-mono text-2xl md:text-3xl font-semibold tracking-tight leading-tight ${
                  positive ? 'text-campo-700 dark:text-campo-400' : 'text-red-700 dark:text-red-400'
                }`}>
                  {signedMoney(side.result, key)}
                </p>

                {/* Income vs expense at a glance. Widths are relative to the
                    larger of the two, so the shorter bar reads as the shortfall. */}
                <div className="flex gap-[3px] mt-3 mb-2" aria-hidden="true">
                  <div
                    className="h-1.5 rounded-l bg-campo-600 dark:bg-campo-500"
                    style={{ width: `${Math.round((side.income / span) * 100)}%` }}
                  />
                  <div
                    className="h-1.5 rounded-r bg-red-500 dark:bg-red-500"
                    style={{ width: `${Math.round((side.expense / span) * 100)}%` }}
                  />
                </div>

                <div className="flex justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
                  <span>Ingresos <span className="font-mono font-semibold text-gray-800 dark:text-gray-100">{money(side.income, key)}</span></span>
                  <span>Gastos <span className="font-mono font-semibold text-gray-800 dark:text-gray-100">{money(side.expense, key)}</span></span>
                </div>

                {top && side.expense > 0 && (
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-2.5 leading-relaxed text-pretty">
                    {percent(top.total, side.expense)}% del gasto es {top.category.toLowerCase()} ({money(top.total, key)}).
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
