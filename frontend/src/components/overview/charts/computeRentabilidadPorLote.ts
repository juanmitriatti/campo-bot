import type { BreakdownRow } from '../../../hooks/useAnalyticsData';

export interface PlotResult {
  plotId: number;
  label: string;
  expenses: number;
  incomes: number;
  resultado: number;
}

/**
 * Group expense + income rows by plot, filter to a single currency, and drop
 * rows without a plot (gastos generales). Output is sorted by absolute
 * resultado descending so the most-impactful lotes show first.
 */
export function computeRentabilidadPorLote(
  expenses: BreakdownRow[],
  incomes: BreakdownRow[],
  currency: string,
): PlotResult[] {
  const byPlot = new Map<number, PlotResult>();

  const upsert = (row: BreakdownRow, kind: 'expenses' | 'incomes') => {
    if (row.plotId == null) return;
    if (row.currency !== currency) return;
    const existing = byPlot.get(row.plotId);
    if (existing) {
      existing[kind] += row.total;
      existing.resultado = existing.incomes - existing.expenses;
    } else {
      const label = row.fieldName ? `${row.fieldName} — ${row.plotName ?? '—'}` : (row.plotName ?? '—');
      const next: PlotResult = {
        plotId: row.plotId,
        label,
        expenses: kind === 'expenses' ? row.total : 0,
        incomes: kind === 'incomes' ? row.total : 0,
        resultado: 0,
      };
      next.resultado = next.incomes - next.expenses;
      byPlot.set(row.plotId, next);
    }
  };

  for (const r of expenses) upsert(r, 'expenses');
  for (const r of incomes) upsert(r, 'incomes');

  return [...byPlot.values()].sort((a, b) => Math.abs(b.resultado) - Math.abs(a.resultado));
}
