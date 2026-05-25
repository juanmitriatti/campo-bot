import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { FeedlotWeightCurveGroup } from '../../../hooks/useLivestockAnalyticsData';

interface Props { groups: FeedlotWeightCurveGroup[]; }

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

export default function FeedlotWeightCurveChart({ groups }: Props) {
  const [focus, setFocus] = useState<string>('__all__');

  const shown = useMemo(() => {
    if (focus === '__all__') return groups;
    return groups.filter(g => g.groupId === focus);
  }, [groups, focus]);

  // Build a unified date axis (union of all dates across visible groups)
  const rows = useMemo(() => {
    const dateSet = new Set<string>();
    for (const g of shown) for (const p of g.points) dateSet.add(p.date.slice(0, 10));
    const dates = [...dateSet].sort();
    return dates.map(d => {
      const row: Record<string, number | string> = { date: d, label: d.slice(5) };
      for (const g of shown) {
        const p = g.points.find(x => x.date.slice(0, 10) === d);
        if (p) row[g.groupId] = p.avgWeightKg;
      }
      return row;
    });
  }, [shown]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Curva de peso (grupos en corral)</h3>
        {groups.length > 1 && (
          <select
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:border-campo-500"
          >
            <option value="__all__">Todos los grupos</option>
            {groups.map(g => <option key={g.groupId} value={g.groupId}>{g.corralName} · {g.groupLabel}</option>)}
          </select>
        )}
      </div>
      {groups.length === 0 ? (
        <div className="text-center py-12 px-4">
          <p className="text-sm text-gray-500 dark:text-gray-300 font-medium mb-1">Sin pesajes en corral</p>
          <p className="text-xs text-gray-400 dark:text-gray-400">Registrá pesajes de los animales en corral para seguir la evolución. Desde el bot: "pesé los novillos del corral 1, peso promedio 380 kg".</p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={50} tickFormatter={(v: number) => `${v} kg`} />
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend formatter={(value: string) => {
              const g = shown.find(x => x.groupId === value);
              return g ? `${g.corralName} · ${g.groupLabel}` : value;
            }} />
            {shown.map((g, i) => (
              <Line key={g.groupId} type="monotone" dataKey={g.groupId} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={{ r: 3 }} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
