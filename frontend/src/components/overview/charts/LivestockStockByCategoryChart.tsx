import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import type { LivestockStockCategoryRow } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: LivestockStockCategoryRow[]; }

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

// Capitalize and pluralize category labels for display
const CATEGORY_LABEL: Record<string, string> = {
  vaca: 'Vacas', vaquillona: 'Vaquillonas',
  ternero: 'Terneros', ternera: 'Terneras',
  novillo: 'Novillos', novillito: 'Novillitos',
  toro: 'Toros', torito: 'Toritos', buey: 'Bueyes',
};

function labelFor(cat: string): string {
  return CATEGORY_LABEL[cat.toLowerCase()] || cat.charAt(0).toUpperCase() + cat.slice(1);
}

export default function LivestockStockByCategoryChart({ data }: Props) {
  const total = data.reduce((s, r) => s + r.headcount, 0);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Stock por categoría</h3>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-300 text-center py-12">Aún no hay hacienda registrada.</p>
      ) : (
        <div className="flex items-center gap-3">
          <div className="relative shrink-0" style={{ width: 160, height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2} dataKey="headcount" nameKey="category" stroke="#fff" strokeWidth={2}>
                  {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [`${Number(v ?? 0)} cabezas`, labelFor(String(n))]} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-xs text-gray-500 dark:text-gray-300">Total</span>
              <span className="text-lg font-bold text-gray-800 dark:text-gray-100">{total}</span>
            </div>
          </div>
          <ul className="flex-1 space-y-1.5 min-w-0">
            {data.map((row, i) => {
              const pct = total > 0 ? Math.round((row.headcount / total) * 100) : 0;
              return (
                <li key={row.category} className="flex items-center gap-2 text-xs">
                  <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                  <span className="text-gray-700 dark:text-gray-200 truncate flex-1">{labelFor(row.category)}</span>
                  <span className="text-gray-900 dark:text-gray-100 font-semibold tabular-nums">{row.headcount}</span>
                  <span className="text-gray-400 dark:text-gray-400 tabular-nums w-9 text-right">{pct}%</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
