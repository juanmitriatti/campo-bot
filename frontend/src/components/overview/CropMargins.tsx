import type { CropMarginRow } from '../../hooks/useOverviewData';
import { money, signedMoney, number } from '../../utils/format';
import type { Currency } from '../../utils/format';

interface Props {
  rows: CropMarginRow[];
  currency: Currency;
}

/**
 * Income, cost and result per crop, plus the per-hectare cost.
 *
 * Built from the lote cards regrouped by the crop each lote carries in the
 * campaign, so this table and the cards never disagree. Only the money that
 * was assigned to a lote takes part: a field-level gasto has no crop.
 */
export default function CropMargins({ rows, currency }: Props) {
  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Margen por cultivo</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">{currency} · solo lo asignado a un lote</span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed max-w-prose">
          Todavía no hay gastos ni ingresos asignados a lotes en {currency}. Cuando le digas al bot
          «gasté 300 mil en gasoil en el lote 1», el cultivo de ese lote aparece acá.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs min-w-[520px]">
            <thead>
              <tr className="text-[11px] text-gray-400 dark:text-gray-500">
                <th className="text-left font-medium px-1 pb-2">Cultivo</th>
                <th className="text-right font-medium px-1 pb-2">ha</th>
                <th className="text-right font-medium px-1 pb-2">Ingresos</th>
                <th className="text-right font-medium px-1 pb-2">Gastos</th>
                <th className="text-right font-medium px-1 pb-2">$/ha</th>
                <th className="text-right font-medium px-1 pb-2">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const perHa = r.hectares > 0 ? r.expense / r.hectares : null;
                const positive = r.result >= 0;
                return (
                  <tr key={r.crop ?? '__none'} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="px-1 py-2">
                      <span className={`font-semibold ${r.crop ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'}`}>
                        {r.crop ?? 'Sin cultivo'}
                      </span>
                      <span className="block text-[11px] text-gray-400 dark:text-gray-500">
                        {r.plots} {r.plots === 1 ? 'lote' : 'lotes'}
                      </span>
                    </td>
                    <td className="px-1 py-2 text-right font-mono tabular-nums text-gray-600 dark:text-gray-300">
                      {r.hectares > 0 ? number(r.hectares) : '—'}
                    </td>
                    <td className="px-1 py-2 text-right font-mono tabular-nums text-gray-900 dark:text-gray-100">
                      {r.income > 0 ? money(r.income, currency) : '—'}
                    </td>
                    <td className="px-1 py-2 text-right font-mono tabular-nums text-gray-900 dark:text-gray-100">
                      {r.expense > 0 ? money(r.expense, currency) : '—'}
                    </td>
                    <td className="px-1 py-2 text-right font-mono tabular-nums text-gray-600 dark:text-gray-300">
                      {perHa != null && r.expense > 0 ? money(perHa, currency) : '—'}
                    </td>
                    <td className={`px-1 py-2 text-right font-mono tabular-nums font-semibold ${
                      r.income > 0
                        ? (positive ? 'text-campo-700 dark:text-campo-400' : 'text-red-700 dark:text-red-400')
                        : 'text-gray-400 dark:text-gray-500'
                    }`}>
                      {r.income > 0 ? signedMoney(r.result, currency) : 'sin ventas'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
