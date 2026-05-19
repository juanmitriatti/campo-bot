import { useMemo, useState } from 'react';
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, LabelList } from 'recharts';
import type { BreakdownRow } from '../../../hooks/useAnalyticsData';
import { computeRentabilidadPorLote } from './computeRentabilidadPorLote';

interface Props {
  expenses: BreakdownRow[];
  incomes: BreakdownRow[];
}

function formatCompact(value: number, currency: string): string {
  const sym = currency === 'USD' ? 'USD ' : '$';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${sym}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${sym}${Math.round(abs / 1_000)}k`;
  return `${sign}${sym}${abs}`;
}

const POS = '#22c55e';
const NEG = '#ef4444';

export default function RentabilidadPorLoteChart({ expenses, incomes }: Props) {
  const [currency, setCurrency] = useState<'ARS' | 'USD'>('ARS');

  const data = useMemo(
    () => {
      const rows = computeRentabilidadPorLote(expenses, incomes, currency);
      // Best on top → worst at the bottom. recharts vertical layout renders
      // first item at the top of the Y axis.
      return [...rows].sort((a, b) => b.resultado - a.resultado);
    },
    [expenses, incomes, currency],
  );

  // Dynamic chart height so bars don't get squished when there are many plots
  // and don't get stretched when there are only a couple.
  const chartHeight = Math.max(180, data.length * 44 + 40);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-start justify-between mb-1 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Rentabilidad por lote</h3>
          <p className="text-xs text-gray-400 dark:text-gray-300">Margen neto (ingresos − gastos) · mes actual</p>
        </div>
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
          {(['ARS', 'USD'] as const).map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setCurrency(c)}
              className={`px-3 py-1 text-xs font-medium transition-colors ${c === currency ? 'bg-campo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {data.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-300 text-center py-12">Aún no hay gastos ni ingresos asignados a lotes este mes.</p>
      ) : (
        <ResponsiveContainer width="100%" height={chartHeight}>
          <BarChart data={data} layout="vertical" margin={{ top: 5, right: 60, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
            <XAxis type="number" tickFormatter={(v) => formatCompact(v, currency)} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="label" tick={{ fontSize: 12 }} width={140} />
            <ReferenceLine x={0} stroke="#9ca3af" strokeWidth={1} />
            <Tooltip
              cursor={{ fill: '#f9fafb' }}
              contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
              formatter={(v: number, _name: string, p: { payload?: { expenses: number; incomes: number } }) => {
                const ing = p.payload?.incomes ?? 0;
                const gas = p.payload?.expenses ?? 0;
                return [
                  `${formatCompact(v, currency)}  (ing ${formatCompact(ing, currency)} − gas ${formatCompact(gas, currency)})`,
                  'Margen',
                ];
              }}
            />
            <Bar dataKey="resultado" radius={[0, 4, 4, 0]}>
              {data.map(d => (
                <Cell key={d.plotId} fill={d.resultado >= 0 ? POS : NEG} />
              ))}
              <LabelList
                dataKey="resultado"
                position="right"
                formatter={(v: number) => formatCompact(v, currency)}
                style={{ fontSize: 11, fontWeight: 600, fill: '#374151' }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
