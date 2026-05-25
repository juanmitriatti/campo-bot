import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import type { AvgWeightCategoryRow } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: AvgWeightCategoryRow[]; }

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

export default function AvgWeightByCategoryChart({ data }: Props) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">Peso promedio</h3>
      <p className="text-xs text-gray-400 mb-3">Último pesaje por categoría · 90 días</p>
      {data.length === 0 ? (
        <div className="text-center py-12 px-4">
          <p className="text-sm text-gray-500 dark:text-gray-300 font-medium mb-1">Sin pesajes recientes</p>
          <p className="text-xs text-gray-400 dark:text-gray-400">Registrá pesajes para ver el peso promedio por categoría.</p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="category" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={45} />
            <Tooltip formatter={(v: number) => [`${Math.round(v)} kg`, 'Peso promedio']} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Bar dataKey="avgWeightKg" radius={[4, 4, 0, 0]}>
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
