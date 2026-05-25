import { useState, useMemo, useEffect } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import type { BreakdownRow } from '../../hooks/useAnalyticsData';
import { useCurrency } from '../../context/CurrencyContext';

interface Props {
  title: string;
  data: BreakdownRow[];
  emptyText?: string;
}

const COLORS = [
  '#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e',
  '#14b8a6', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899',
];

const ALL = '__all__';
const NO_PLOT = '__no_plot__';

interface PlotOption {
  key: string;
  label: string;
  total: number;
}

function formatMoney(n: number, currency: string): string {
  const symbol = currency === 'USD' ? 'USD ' : '$';
  if (n >= 1_000_000) return `${symbol}${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${symbol}${Math.round(n / 1_000)}k`;
  return `${symbol}${new Intl.NumberFormat('es-AR').format(n)}`;
}

export default function CategoryDonutChart({ title, data, emptyText = 'Sin movimientos este mes' }: Props) {
  const { currency } = useCurrency();
  const [selected, setSelected] = useState<string>(ALL);

  // Filter rows by selected currency
  const currencyData = useMemo(
    () => data.filter(r => r.currency === currency),
    [data, currency],
  );

  // Build plot options (within current currency)
  const plotOptions: PlotOption[] = useMemo(() => {
    const opts = new Map<string, PlotOption>();
    let allTotal = 0;
    let noPlotTotal = 0;
    for (const row of currencyData) {
      allTotal += row.total;
      if (row.plotId == null) {
        noPlotTotal += row.total;
        continue;
      }
      const key = String(row.plotId);
      const label = row.fieldName
        ? `${row.plotName} (${row.fieldName})`
        : row.plotName || '—';
      const prev = opts.get(key);
      opts.set(key, { key, label, total: (prev?.total || 0) + row.total });
    }
    const result: PlotOption[] = [{ key: ALL, label: 'Todos los lotes', total: allTotal }];
    const plotList = [...opts.values()].sort((a, b) => b.total - a.total);
    result.push(...plotList);
    if (noPlotTotal > 0) {
      result.push({ key: NO_PLOT, label: 'Sin lote asignado', total: noPlotTotal });
    }
    return result;
  }, [currencyData]);

  // If the currently-selected plot disappears (currency change), reset to ALL
  useEffect(() => {
    if (!plotOptions.some(o => o.key === selected)) {
      setSelected(ALL);
    }
  }, [plotOptions, selected]);

  // Aggregate by category
  const chartData = useMemo(() => {
    const filtered = currencyData.filter(r => {
      if (selected === ALL) return true;
      if (selected === NO_PLOT) return r.plotId == null;
      return String(r.plotId) === selected;
    });
    const byCategory = new Map<string, number>();
    for (const row of filtered) {
      byCategory.set(row.category, (byCategory.get(row.category) || 0) + row.total);
    }
    return [...byCategory.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [currencyData, selected]);

  const total = chartData.reduce((s, d) => s + d.value, 0);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm p-5 min-h-[340px] flex flex-col">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{title}</h3>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="text-xs border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 dark:text-gray-100 focus:outline-none focus:border-campo-500 focus:ring-1 focus:ring-campo-500"
        >
          {plotOptions.map(opt => (
            <option key={opt.key} value={opt.key}>
              {opt.label} — {formatMoney(opt.total, currency)}
            </option>
          ))}
        </select>
      </div>

      {chartData.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-300 text-center py-12">{emptyText}</p>
      ) : (
        <div className="flex flex-col lg:flex-row items-center gap-4">
          <div className="w-full lg:w-1/2 h-64 relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={95}
                  paddingAngle={2}
                  dataKey="value"
                  stroke="#fff"
                  strokeWidth={2}
                >
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v: number, n: string) => [formatMoney(v, currency), n]}
                  contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-xs text-gray-500 dark:text-gray-300">Total</span>
              <span className="text-lg font-bold text-gray-800 dark:text-gray-100">{formatMoney(total, currency)}</span>
            </div>
          </div>
          <ul className="w-full lg:w-1/2 space-y-1.5 text-sm">
            {chartData.map((d, i) => {
              const pct = total > 0 ? (d.value / total) * 100 : 0;
              return (
                <li
                  key={d.name}
                  className="grid items-center gap-2"
                  style={{ gridTemplateColumns: '12px minmax(0,1fr) auto 44px' }}
                >
                  <span
                    className="w-3 h-3 rounded-sm shrink-0"
                    style={{ background: COLORS[i % COLORS.length] }}
                  />
                  <span className="text-gray-700 dark:text-gray-200 truncate">{d.name}</span>
                  <span className="font-medium text-gray-800 dark:text-gray-100 tabular-nums text-right">{formatMoney(d.value, currency)}</span>
                  <span className="text-xs text-gray-400 dark:text-gray-300 tabular-nums text-right">{pct.toFixed(0)}%</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
