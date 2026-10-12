import { useState } from 'react';
import type { CropMarginRow } from '../../hooks/useOverviewData';
import { money, signedMoney, number } from '../../utils/format';
import type { Currency } from '../../utils/format';

interface Props {
  rows: CropMarginRow[];
  currency: Currency;
  /** Todo en dólares (cada peso al dólar de su fecha); ausente en backends viejos. */
  usdEqRows?: CropMarginRow[];
  fxSource?: string;
}

/**
 * Income, cost and result per crop, plus the per-hectare cost.
 *
 * One row per crop of the campaign ("Trigo", "Soja 2da", "Soja"): each lote
 * contributes the money of each of its campaigns, including the barbecho before
 * sowing, grain sold after closing and its share of field-level costs. Same
 * query as the lote cards, so the two never disagree.
 *
 * By default everything in dollars (each peso at the dollar of its date): with
 * costs in pesos and grain in dollars, a single-currency margin is half a story.
 */
export default function CropMargins({ rows: currencyRows, currency, usdEqRows, fxSource }: Props) {
  const [allInUsd, setAllInUsd] = useState(true);
  const useEq = allInUsd && !!usdEqRows;
  const rows = useEq ? usdEqRows! : currencyRows;
  const shown: Currency = useEq ? 'USD' : currency;
  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Margen por cultivo</h2>
        {usdEqRows ? (
          <div className="flex text-[11px] rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden" role="group" aria-label="Moneda del margen">
            <button
              type="button"
              onClick={() => setAllInUsd(true)}
              aria-pressed={useEq}
              className={`px-2 py-1 min-h-[28px] ${useEq ? 'bg-campo-600 text-white' : 'text-gray-500 dark:text-gray-400'}`}
            >Todo en USD</button>
            <button
              type="button"
              onClick={() => setAllInUsd(false)}
              aria-pressed={!useEq}
              className={`px-2 py-1 min-h-[28px] ${!useEq ? 'bg-campo-600 text-white' : 'text-gray-500 dark:text-gray-400'}`}
            >Solo {currency}</button>
          </div>
        ) : (
          <span className="text-xs text-gray-400 dark:text-gray-500">{currency}</span>
        )}
      </div>
      {useEq && fxSource && (
        <p className="text-[11px] text-gray-400 dark:text-gray-500 -mt-2 mb-3">Cada peso al {fxSource} de su fecha.</p>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed max-w-prose">
          Todavía no hay gastos ni ingresos de campañas en {shown}. Cuando le digas al bot
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
                        {r.crop ?? 'Sin campaña'}
                      </span>
                      <span className="block text-[11px] text-gray-400 dark:text-gray-500">
                        {r.plots} {r.plots === 1 ? 'lote' : 'lotes'}
                      </span>
                    </td>
                    <td className="px-1 py-2 text-right font-mono tabular-nums text-gray-600 dark:text-gray-300">
                      {r.hectares > 0 ? number(r.hectares) : '—'}
                    </td>
                    <td className="px-1 py-2 text-right font-mono tabular-nums text-gray-900 dark:text-gray-100">
                      {r.income > 0 ? money(r.income, shown) : '—'}
                    </td>
                    <td className="px-1 py-2 text-right font-mono tabular-nums text-gray-900 dark:text-gray-100">
                      {r.expense > 0 ? money(r.expense, shown) : '—'}
                    </td>
                    <td className="px-1 py-2 text-right font-mono tabular-nums text-gray-600 dark:text-gray-300">
                      {perHa != null && r.expense > 0 ? money(perHa, shown) : '—'}
                    </td>
                    <td className={`px-1 py-2 text-right font-mono tabular-nums font-semibold ${
                      r.income > 0
                        ? (positive ? 'text-campo-700 dark:text-campo-400' : 'text-red-700 dark:text-red-400')
                        : 'text-gray-400 dark:text-gray-500'
                    }`}>
                      {r.income > 0 ? signedMoney(r.result, shown) : 'sin ventas'}
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
