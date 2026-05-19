import { useMemo } from 'react';
import { ComposedChart, Bar, Scatter, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { AgronomicRainfallMonth, AgronomicHarvestMonth } from '../../../hooks/useAgronomicAnalyticsData';

interface Props {
  rainfall: AgronomicRainfallMonth[];
  harvests: AgronomicHarvestMonth[];
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

function colorForCrop(crop: string | null): string {
  if (!crop) return '#6b7280';
  return CROP_COLORS[crop.toLowerCase()] ?? '#6b7280';
}

export default function RainfallYieldTrendChart({ rainfall, harvests }: Props) {
  // Merge by month: each row has mm + per-month scatter points (yield).
  const data = useMemo(() => {
    const map = new Map<string, { month: string; label: string; mm: number; yield_kg_per_ha?: number; crop?: string | null; plot?: string | null }>();
    for (const r of rainfall) {
      map.set(r.month, { month: r.month, label: r.label, mm: r.mm });
    }
    // We attach yields as separate Scatter series; for the merged chart we
    // emit one entry per harvest, keyed by month label, with the yield.
    const out: Array<{ month: string; label: string; mm: number; yield_kg_per_ha: number | null; crop: string | null; plot: string | null }> = [];
    for (const m of map.values()) {
      out.push({ ...m, yield_kg_per_ha: null, crop: null, plot: null });
    }
    for (const h of harvests) {
      if (h.yieldKgPerHa == null) continue;
      const baseline = map.get(h.month);
      if (!baseline) continue;
      out.push({
        month: h.month,
        label: h.label,
        mm: baseline.mm,
        yield_kg_per_ha: h.yieldKgPerHa,
        crop: h.crop,
        plot: h.plotName,
      });
    }
    return out.sort((a, b) => a.month.localeCompare(b.month));
  }, [rainfall, harvests]);

  const hasAnything = rainfall.some(r => r.mm > 0) || harvests.some(h => h.yieldKgPerHa != null);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Lluvias y rendimiento (12 meses)</h3>
      {!hasAnything ? (
        <p className="text-sm text-gray-400 dark:text-gray-300 text-center py-12">Aún no hay lluvias ni cosechas en los últimos 12 meses.</p>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={data} margin={{ top: 5, right: 30, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="left" orientation="left" tick={{ fontSize: 11 }} width={50} label={{ value: 'mm', angle: -90, position: 'insideLeft', fontSize: 11, fill: '#3b82f6' }} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} width={60} label={{ value: 'kg/ha', angle: 90, position: 'insideRight', fontSize: 11, fill: '#ca8a04' }} />
            <Tooltip
              contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
              formatter={(v: number, name: string, p: { payload?: { crop?: string | null; plot?: string | null } }) => {
                if (name === 'mm') return [`${v} mm`, 'Lluvia'];
                if (name === 'yield_kg_per_ha') {
                  const crop = p.payload?.crop ?? 'cultivo';
                  const plot = p.payload?.plot ?? '';
                  return [`${Math.round(v)} kg/ha`, `${plot} — ${crop}`];
                }
                return [v, name];
              }}
            />
            <Legend formatter={(value: string) => value === 'mm' ? 'Lluvia mensual' : 'Rinde por cosecha'} />
            <Bar yAxisId="left" dataKey="mm" fill="#3b82f6" name="mm" />
            <Scatter yAxisId="right" dataKey="yield_kg_per_ha" name="yield_kg_per_ha" fill="#ca8a04" shape="circle" />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// `colorForCrop` kept for future per-point coloring once recharts Scatter supports per-point fill via Cell.
void colorForCrop;
