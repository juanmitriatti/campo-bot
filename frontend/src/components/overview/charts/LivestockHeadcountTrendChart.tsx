import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { LivestockHeadcountMonth } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: LivestockHeadcountMonth[]; }

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

export default function LivestockHeadcountTrendChart({ data }: Props) {
  // Collect every category that appears in any month so the chart has a
  // stable set of series (gaps become 0).
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of data) for (const k of Object.keys(m.byCategory)) set.add(k);
    return [...set].sort();
  }, [data]);

  // Flatten into rechart-friendly rows: { label, [cat1]: n, [cat2]: n, ... }
  const rows = useMemo(() => {
    return data.map(m => {
      const out: Record<string, number | string> = { label: m.label };
      for (const c of categories) out[c] = m.byCategory[c] ?? 0;
      return out;
    });
  }, [data, categories]);

  const hasAnything = data.some(m => Object.values(m.byCategory).some(v => v !== 0));

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">Evolución de cabezas (delta mensual)</h3>
      <p className="text-xs text-gray-400 mb-3">Altas (+) y bajas (−) por categoría, 12 meses</p>
      {!hasAnything ? (
        <p className="text-sm text-gray-400 text-center py-12">Sin movimientos en los últimos 12 meses.</p>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={45} />
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend />
            {categories.map((c, i) => (
              <Area key={c} type="monotone" dataKey={c} stackId="1" stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.5} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
