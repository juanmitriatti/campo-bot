import { useMemo, useState } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
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

export default function RentabilidadPorLoteChart({ expenses, incomes }: Props) {
  const [currency, setCurrency] = useState<'ARS' | 'USD'>('ARS');

  const data = useMemo(
    () => computeRentabilidadPorLote(expenses, incomes, currency),
    [expenses, incomes, currency],
  );

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-start justify-between mb-1 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">Rentabilidad por lote</h3>
          <p className="text-xs text-gray-400">Gastos sin lote excluidos · mes actual</p>
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
        <p className="text-sm text-gray-400 text-center py-12">Aún no hay gastos ni ingresos asignados a lotes este mes.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} angle={-15} textAnchor="end" height={50} />
            <YAxis tickFormatter={(v) => formatCompact(v, currency)} tick={{ fontSize: 11 }} width={60} />
            <Tooltip
              formatter={(v: number, name: string) => {
                const labelMap: Record<string, string> = { expenses: 'Gastos', incomes: 'Ingresos', resultado: 'Resultado' };
                return [formatCompact(v, currency), labelMap[name] ?? name];
              }}
              contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
            />
            <Legend formatter={(value: string) => ({ expenses: 'Gastos', incomes: 'Ingresos', resultado: 'Resultado' } as Record<string, string>)[value] ?? value} />
            <Bar dataKey="expenses" fill="#ef4444" radius={[4, 4, 0, 0]} />
            <Bar dataKey="incomes" fill="#22c55e" radius={[4, 4, 0, 0]} />
            <Line type="monotone" dataKey="resultado" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
