import type { HarvestQualityLoad } from '../../hooks/useAgronomicAnalyticsData';

interface Props {
  loads: HarvestQualityLoad[];
}

const METRIC_LABEL: Record<string, string> = {
  oil_pct: 'aceite',
  protein_pct: 'proteína',
  gluten_pct: 'gluten',
  test_weight: 'peso hectolítrico',
  protein: 'proteína',
  gluten: 'gluten',
};

interface Agg {
  crop: string;
  loads: number;
  humidity: number[];
  metrics: Map<string, number[]>;
}

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const fmt = (n: number) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 }).format(n);

/**
 * Humidity and quality of the delivered grain, per crop.
 *
 * Per-truck numbers are a table for the Cosechas tab; here they are averaged
 * by crop with the range, which is what decides the discount at the acopio.
 * Only loads that carried BOTH humidity and a quality metric take part.
 */
export default function HarvestQualityCard({ loads }: Props) {
  const byCrop = new Map<string, Agg>();
  for (const l of loads) {
    const crop = l.crop ?? 'Sin cultivo';
    const a: Agg = byCrop.get(crop) ?? { crop, loads: 0, humidity: [], metrics: new Map<string, number[]>() };
    a.loads += 1;
    a.humidity.push(l.humidityPct);
    for (const [k, v] of Object.entries(l.quality ?? {})) {
      if (typeof v !== 'number' || isNaN(v)) continue;
      const list = a.metrics.get(k) ?? [];
      list.push(v);
      a.metrics.set(k, list);
    }
    byCrop.set(crop, a);
  }
  const rows = Array.from(byCrop.values()).sort((a, b) => b.loads - a.loads);

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Calidad de lo entregado</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">humedad y análisis por cultivo</span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed max-w-prose">
          Ningún camión de esta campaña tiene humedad y análisis cargados. Decile al bot «camión de Pérez
          28.500 kg al 14% con 22 de aceite» y aparece acá.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map(r => (
            <div key={r.crop} className="border-t border-gray-100 dark:border-gray-700 first:border-t-0 pt-3 first:pt-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">{r.crop}</span>
                <span className="text-[11px] text-gray-400 dark:text-gray-500">{r.loads} {r.loads === 1 ? 'camión' : 'camiones'}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-xs text-gray-600 dark:text-gray-300">
                <span>
                  humedad <span className="font-mono font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{fmt(avg(r.humidity))}%</span>
                  {r.humidity.length > 1 && (
                    <span className="text-gray-400 dark:text-gray-500"> ({fmt(Math.min(...r.humidity))}–{fmt(Math.max(...r.humidity))})</span>
                  )}
                </span>
                {Array.from(r.metrics.entries()).map(([k, xs]) => (
                  <span key={k}>
                    {METRIC_LABEL[k] ?? k.replace(/_/g, ' ')}{' '}
                    <span className="font-mono font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{fmt(avg(xs))}</span>
                    {xs.length > 1 && (
                      <span className="text-gray-400 dark:text-gray-500"> ({fmt(Math.min(...xs))}–{fmt(Math.max(...xs))})</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
