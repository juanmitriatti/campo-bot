import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import type { YieldByCropRow } from '../../../hooks/useAgronomicAnalyticsData';

interface Props {
  data: YieldByCropRow[];
}

const CROP_COLORS: Record<string, string> = {
  soja: '#ca8a04',
  maíz: '#f59e0b',
  trigo: '#84cc16',
  girasol: '#f97316',
  sorgo: '#a16207',
  cebada: '#a3a3a3',
  avena: '#737373',
};

function colorForCrop(crop: string): string {
  return CROP_COLORS[crop.toLowerCase()] ?? '#6b7280';
}

export default function YieldByCropChart({ data }: Props) {
  const rows = data.filter(d => d.avgKgPerHa != null);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Rendimiento por cultivo (kg/ha promedio · 12 meses)</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-300 text-center py-12">Aún no hay cosechas en los últimos 12 meses.</p>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={rows} layout="vertical" margin={{ top: 5, right: 30, left: 30, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(v)}`} />
            <YAxis type="category" dataKey="crop" tick={{ fontSize: 12 }} width={80} />
            <Tooltip
              formatter={(v, _name, p) => { const row = p?.payload as YieldByCropRow | undefined; return [`${Math.round(Number(v ?? 0))} kg/ha`, row ? `${row.crop} (${row.harvests} cosechas)` : '']; }}
              contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
            />
            <Bar dataKey="avgKgPerHa" radius={[0, 4, 4, 0]}>
              {rows.map(r => <Cell key={r.crop} fill={colorForCrop(r.crop)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
