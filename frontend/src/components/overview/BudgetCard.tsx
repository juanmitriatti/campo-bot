import type { BudgetRow } from '../../hooks/useOverviewData';
import { money, percent } from '../../utils/format';

interface Props {
  month: string;
  rows: BudgetRow[];
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function monthName(yyyyMm: string): string {
  const idx = parseInt(yyyyMm.slice(5, 7), 10) - 1;
  return MONTHS[idx] ?? yyyyMm;
}

/**
 * Budget vs. actual for the current month.
 *
 * `set_budget` has existed in the bot for a long time and this is the first
 * place the dashboard shows it. Budgets are monthly and in pesos (that is
 * what the bot stores), so the card is monthly and in pesos regardless of the
 * campaign or currency selected above — it says so in the header.
 */
export default function BudgetCard({ month, rows }: Props) {
  if (rows.length === 0) return null;

  const over = rows.filter(r => r.spent > r.limit).length;

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Presupuestos de {monthName(month)}</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {over > 0 ? `${over} ${over === 1 ? 'pasado' : 'pasados'} · ` : ''}ARS · por mes
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        {rows.map(r => {
          const pct = r.limit > 0 ? Math.min(100, Math.round((r.spent / r.limit) * 100)) : 0;
          const exceeded = r.spent > r.limit;
          const warn = !exceeded && pct >= 80;
          return (
            <div key={r.category}>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-xs text-gray-600 dark:text-gray-300 truncate">{r.category}</span>
                <span className="font-mono text-xs tabular-nums text-gray-900 dark:text-gray-100">
                  <span className={`font-semibold ${exceeded ? 'text-red-700 dark:text-red-400' : ''}`}>{money(r.spent, 'ARS')}</span>
                  <span className="text-gray-400 dark:text-gray-500"> / {money(r.limit, 'ARS')}</span>
                </span>
              </div>
              <div className="h-2 rounded bg-gray-100 dark:bg-gray-700 overflow-hidden">
                <div
                  className={`h-full rounded ${
                    exceeded ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-campo-600 dark:bg-campo-500'
                  }`}
                  style={{ width: `${Math.max(2, pct)}%` }}
                  title={`${percent(r.spent, r.limit)}% del presupuesto`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
