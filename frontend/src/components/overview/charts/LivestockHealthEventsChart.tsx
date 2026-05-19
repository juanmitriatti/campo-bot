import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { MonthlyEventsByType } from '../../../hooks/useLivestockAnalyticsData';

interface Props { data: MonthlyEventsByType[]; }

const TYPE_COLORS: Record<string, string> = {
  vacunacion: '#3b82f6',
  desparasitacion: '#22c55e',
  tratamiento: '#f59e0b',
  revision_sanitaria: '#a855f7',
};

const TYPE_LABELS: Record<string, string> = {
  vacunacion: 'Vacunación',
  desparasitacion: 'Desparasitación',
  tratamiento: 'Tratamiento',
  revision_sanitaria: 'Revisión',
};

export default function LivestockHealthEventsChart({ data }: Props) {
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const m of data) for (const k of Object.keys(m.byType)) set.add(k);
    return [...set].sort();
  }, [data]);

  const rows = useMemo(() => data.map(m => {
    const out: Record<string, number | string> = { label: m.label };
    for (const t of types) out[t] = m.byType[t] ?? 0;
    return out;
  }), [data, types]);

  const hasAnything = data.some(m => Object.values(m.byType).some(v => v > 0));

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Sanidad — eventos mensuales</h3>
      {!hasAnything ? (
        <p className="text-sm text-gray-400 dark:text-gray-300 text-center py-12">Sin eventos sanitarios en 12 meses.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={35} />
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} formatter={(v: number, name: string) => [v, TYPE_LABELS[name] ?? name]} />
            <Legend formatter={(value: string) => TYPE_LABELS[value] ?? value} />
            {types.map(t => (
              <Bar key={t} dataKey={t} stackId="health" fill={TYPE_COLORS[t] ?? '#6b7280'} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
