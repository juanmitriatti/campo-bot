import { AlertTriangle } from 'lucide-react';
import type { OverviewPlot } from '../../hooks/useOverviewData';
import { money, signedMoney, hectares, number } from '../../utils/format';
import type { Currency } from '../../utils/format';

interface Props {
  plots: OverviewPlot[];
  currency: Currency;
  /** Plot ids that a "Para revisar" finding points at. */
  flagged?: Set<number>;
  onOpenPlot?: (plotId: number) => void;
}

/**
 * The lotes, as cards.
 *
 * The lote is the productive unit in this domain, so the Resumen shows them
 * directly instead of making the user infer them from a treemap. Crop identity
 * is carried by its NAME, not a colour: four crops cannot be given four hues
 * that stay distinguishable for colour-blind readers in both themes, and the
 * word is right there anyway.
 */
export default function PlotCards({ plots, currency, flagged, onOpenPlot }: Props) {
  const totalHa = plots.reduce((s, p) => s + (p.areaHectares ?? 0), 0);

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Lotes</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {plots.length} {plots.length === 1 ? 'lote' : 'lotes'}
          {totalHa > 0 && ` · ${number(totalHa)} ha declaradas`}
        </span>
      </div>

      {plots.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed max-w-prose">
          No hay lotes cargados en esta selección. Decile al bot algo como
          «agregá el lote 1 a La Esperanza» y aparecen acá.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {plots.map(p => {
            const spend = currency === 'ARS' ? p.spendARS : p.spendUSD;
            const income = currency === 'ARS' ? p.incomeARS : p.incomeUSD;
            const isFlagged = flagged?.has(p.id) ?? false;
            const Wrapper = onOpenPlot ? 'button' : 'div';
            return (
              <Wrapper
                key={p.id}
                {...(onOpenPlot ? { onClick: () => onOpenPlot(p.id), type: 'button' as const } : {})}
                className={`text-left bg-gray-50 dark:bg-gray-900/40 border rounded-lg p-3.5 ${
                  isFlagged ? 'border-amber-200 dark:border-amber-900' : 'border-gray-100 dark:border-gray-700'
                } ${onOpenPlot ? 'hover:border-gray-300 dark:hover:border-gray-600 transition-colors' : ''}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold text-gray-900 dark:text-gray-100 leading-tight truncate">{p.name}</p>
                    <p className="text-[11.5px] text-gray-400 dark:text-gray-500 mt-0.5 truncate">{p.fieldName}</p>
                  </div>
                  <span className="font-mono text-[11.5px] text-gray-400 dark:text-gray-500 shrink-0 tabular-nums">
                    {hectares(p.areaHectares)}
                  </span>
                </div>

                <div className="flex items-center gap-2 flex-wrap mt-2.5 mb-2">
                  <span className={`text-xs font-semibold ${p.crop ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'}`}>
                    {p.crop ?? 'Sin cultivo'}
                  </span>
                  {p.cropState && (
                    <span className="text-[11.5px] text-gray-400 dark:text-gray-500">{p.cropState}</span>
                  )}
                </div>

                <div className="h-px bg-gray-200 dark:bg-gray-700 mb-2" />

                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <span className="text-[11.5px] text-gray-400 dark:text-gray-500">Gastado</span>
                  <span className="font-mono text-xs font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                    {spend > 0 ? money(spend, currency) : '—'}
                  </span>
                </div>

                {/* Only when this lote actually sold something: a "result" that
                    is just the cost negated would be noise on every card. */}
                {income > 0 && (
                  <div className="flex items-baseline justify-between gap-2 mb-1.5">
                    <span className="text-[11.5px] text-gray-400 dark:text-gray-500">Resultado</span>
                    <span className={`font-mono text-xs font-semibold tabular-nums ${
                      income - spend >= 0 ? 'text-campo-700 dark:text-campo-400' : 'text-red-700 dark:text-red-400'
                    }`}>
                      {signedMoney(income - spend, currency)}
                    </span>
                  </div>
                )}

                <p className="text-[11.5px] text-gray-400 dark:text-gray-500 leading-snug text-pretty">
                  {p.lastActivity ?? 'Sin actividad cargada en esta campaña'}
                </p>

                {isFlagged && (
                  <div className="flex items-center gap-1.5 mt-2.5 pt-2 border-t border-dashed border-amber-200 dark:border-amber-900">
                    <AlertTriangle className="w-3 h-3 text-amber-600 dark:text-amber-500 shrink-0" />
                    <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-500 leading-snug">
                      Tiene algo para revisar
                    </span>
                  </div>
                )}
              </Wrapper>
            );
          })}
        </div>
      )}
    </section>
  );
}
