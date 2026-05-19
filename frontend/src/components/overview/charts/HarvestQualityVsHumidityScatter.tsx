import { useMemo } from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Cell } from 'recharts';
import type { HarvestQualityLoad } from '../../../hooks/useAgronomicAnalyticsData';

interface Props {
  loads: HarvestQualityLoad[];
}

interface PreparedPoint {
  loadId: number;
  crop: string;
  humidity: number;
  quality: number;
  qualityField: string;
  plot: string | null;
  harvestedAt: string;
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

// Pick the most informative quality metric per crop.
function extractQuality(crop: string | null, q: Record<string, number>): { value: number; field: string } | null {
  if (!q) return null;
  const tryFields = (() => {
    switch ((crop ?? '').toLowerCase()) {
      case 'soja': return ['oil_pct'];
      case 'girasol': return ['oil_pct'];
      case 'trigo': return ['protein_pct', 'gluten_pct', 'test_weight_kg_hl'];
      default: return Object.keys(q);
    }
  })();
  for (const f of tryFields) {
    if (typeof q[f] === 'number') return { value: q[f], field: f };
  }
  return null;
}

// AR commercial base humidity reference per crop.
const HUMIDITY_BASE: Record<string, number> = {
  soja: 13.5,
  trigo: 14,
  maíz: 14.5,
};

export default function HarvestQualityVsHumidityScatter({ loads }: Props) {
  const points = useMemo<PreparedPoint[]>(() => {
    const out: PreparedPoint[] = [];
    for (const l of loads) {
      if (!l.crop) continue;
      const q = extractQuality(l.crop, l.quality);
      if (!q) continue;
      out.push({
        loadId: l.loadId,
        crop: l.crop,
        humidity: l.humidityPct,
        quality: q.value,
        qualityField: q.field,
        plot: l.plotName,
        harvestedAt: l.harvestedAt,
      });
    }
    return out;
  }, [loads]);

  // Group points by crop so each scatter series can have its own color.
  const byCrop = useMemo(() => {
    const m = new Map<string, PreparedPoint[]>();
    for (const p of points) {
      const list = m.get(p.crop) ?? [];
      list.push(p);
      m.set(p.crop, list);
    }
    return [...m.entries()];
  }, [points]);

  // Reference lines for the crops we have data for.
  const referenceLines = useMemo(() => {
    const crops = new Set(points.map(p => p.crop.toLowerCase()));
    return Object.entries(HUMIDITY_BASE).filter(([c]) => crops.has(c));
  }, [points]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">Calidad vs humedad de cosecha</h3>
      <p className="text-xs text-gray-400 mb-3">Una carga = un punto · línea punteada = humedad base AR</p>
      {points.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-12">No hay cargas con humedad y calidad cargadas.</p>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <ScatterChart margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis type="number" dataKey="humidity" name="Humedad" unit="%" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
            <YAxis type="number" dataKey="quality" name="Calidad" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
            <ZAxis range={[60, 60]} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
              formatter={(v: number, name: string) => {
                if (name === 'Humedad') return [`${v}%`, name];
                if (name === 'Calidad') return [`${v}`, name];
                return [v, name];
              }}
              labelFormatter={() => ''}
            />
            {referenceLines.map(([crop, base]) => (
              <ReferenceLine key={crop} x={base} stroke="#d1d5db" strokeDasharray="4 4" label={{ value: `${crop} base ${base}%`, fontSize: 10, position: 'top', fill: '#9ca3af' }} />
            ))}
            {byCrop.map(([crop, pts]) => (
              <Scatter key={crop} name={crop} data={pts}>
                {pts.map(p => <Cell key={p.loadId} fill={colorForCrop(crop)} />)}
              </Scatter>
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
