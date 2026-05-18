import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import type { LivestockStockCategoryRow } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: LivestockStockCategoryRow[]; }

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

export default function LivestockStockByCategoryChart({ data }: Props) {
  const total = data.reduce((s, r) => s + r.headcount, 0);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Stock por categoría</h3>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-12">Aún no hay hacienda registrada.</p>
      ) : (
        <div className="h-56 relative">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2} dataKey="headcount" nameKey="category" stroke="#fff" strokeWidth={2}>
                {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v: number, n: string) => [`${v} cabezas`, n]} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-xs text-gray-500">Total</span>
            <span className="text-lg font-bold text-gray-800">{total}</span>
          </div>
        </div>
      )}
    </div>
  );
}
