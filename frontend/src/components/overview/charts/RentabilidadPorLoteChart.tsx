import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, LabelList } from 'recharts';
import type { BreakdownRow } from '../../../hooks/useAnalyticsData';
import { computeRentabilidadPorLote } from './computeRentabilidadPorLote';
import { useCurrency } from '../../../context/CurrencyContext';

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

const GASTOS_COLOR = '#ef4444'; // red-500
const INGRESOS_COLOR = '#22c55e'; // green-500

export default function RentabilidadPorLoteChart({ expenses, incomes }: Props) {
  const { currency } = useCurrency();

  const data = useMemo(
    () => {
      const rows = computeRentabilidadPorLote(expenses, incomes, currency);
      // Order by total volume (expenses+incomes) so the most-active plots show
      // first left-to-right.
      return [...rows].sort((a, b) => (b.expenses + b.incomes) - (a.expenses + a.incomes));
    },
    [expenses, incomes, currency],
  );

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Rentabilidad por lote</h3>
        <p className="text-xs text-gray-400 dark:text-gray-300">Gastos vs Ingresos · mes actual · {currency}</p>
      </div>

      {data.length === 0 ? (
        <div className="text-center py-12 px-4">
          <p className="text-sm text-gray-500 dark:text-gray-300 font-medium mb-1">Sin datos por lote este mes</p>
          <p className="text-xs text-gray-400 dark:text-gray-400">Asigná gastos e ingresos a lotes para ver la rentabilidad por unidad productiva. Desde el bot: "gasté X en gasoil en lote A1".</p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={data} margin={{ top: 20, right: 20, left: 10, bottom: 60 }} barGap={4} barCategoryGap="20%">
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: '#6b7280' }}
              angle={-30}
              textAnchor="end"
              interval={0}
              height={70}
            />
            <YAxis
              tickFormatter={(v) => formatCompact(v, currency)}
              tick={{ fontSize: 11, fill: '#6b7280' }}
              width={70}
            />
            <Tooltip
              cursor={{ fill: 'rgba(243, 244, 246, 0.6)' }}
              contentStyle={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb' }}
              formatter={(value, name) => [formatCompact(Number(value ?? 0), currency), String(name)]}
              labelStyle={{ fontWeight: 600, color: '#374151' }}
            />
            <Legend
              wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
              iconType="rect"
            />
            <Bar dataKey="expenses" name="Gastos" fill={GASTOS_COLOR} radius={[4, 4, 0, 0]}>
              <LabelList
                dataKey="expenses"
                position="top"
                formatter={(v) => Number(v) > 0 ? formatCompact(Number(v), currency) : ''}
                style={{ fontSize: 10, fontWeight: 600, fill: GASTOS_COLOR }}
              />
            </Bar>
            <Bar dataKey="incomes" name="Ingresos" fill={INGRESOS_COLOR} radius={[4, 4, 0, 0]}>
              <LabelList
                dataKey="incomes"
                position="top"
                formatter={(v) => Number(v) > 0 ? formatCompact(Number(v), currency) : ''}
                style={{ fontSize: 10, fontWeight: 600, fill: INGRESOS_COLOR }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
