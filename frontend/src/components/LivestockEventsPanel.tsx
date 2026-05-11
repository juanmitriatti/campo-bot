import { useEffect, useState, useCallback, useMemo } from 'react';
import { apiRequest } from '../api/client';

type EventType = 'health_event' | 'repro_event' | 'weighing';

interface LivestockEvent {
  id: number;
  eventDate: string;
  eventType: EventType;
  subtype: string | null;
  product: string | null;
  quantity: number | null;
  unit: string | null;
  implement: string | null;
  category: string | null;
  animalsAffected: number | null;
  notes: string | null;
  plotId: number | null;
  plotName: string | null;
  fieldName: string | null;
  corralName: string | null;
  feedlotName: string | null;
}

interface ListResponse { data: LivestockEvent[] }

interface FieldOption { id: number; name: string; plots: { id: number; name: string }[] }

import { Syringe, Bug, Pill, Stethoscope, Heart, MilkOff, Thermometer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const HEALTH_LABELS: Record<string, { label: string; Icon: LucideIcon }> = {
  vacunacion: { label: 'Vacunación', Icon: Syringe },
  desparasitacion: { label: 'Desparasitación', Icon: Bug },
  tratamiento: { label: 'Tratamiento', Icon: Pill },
  revision_sanitaria: { label: 'Revisión sanitaria', Icon: Stethoscope },
};

const REPRO_LABELS: Record<string, { label: string; Icon: LucideIcon }> = {
  servicio: { label: 'Servicio (entore)', Icon: Heart },
  destete: { label: 'Destete', Icon: MilkOff },
  inseminacion: { label: 'Inseminación', Icon: Syringe },
  deteccion_celo: { label: 'Detección de celo', Icon: Thermometer },
};

const CATEGORY_LABEL: Record<string, string> = {
  vaca: 'Vaca', vaquillona: 'Vaquillona', ternero: 'Ternero', ternera: 'Ternera',
  novillo: 'Novillo', novillito: 'Novillito', toro: 'Toro', torito: 'Torito', buey: 'Buey',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function describeLocation(e: LivestockEvent): string {
  if (e.corralName) return e.feedlotName ? `🔲 ${e.corralName} (${e.feedlotName})` : `🔲 ${e.corralName}`;
  if (e.plotName) return e.fieldName ? `${e.plotName} · ${e.fieldName}` : e.plotName;
  return '—';
}

function describeAnimals(e: LivestockEvent): string {
  if (!e.animalsAffected && !e.category) return '—';
  const cat = e.category ? CATEGORY_LABEL[e.category] || e.category : 'animales';
  if (!e.animalsAffected) return cat;
  return `${e.animalsAffected} ${cat}${e.animalsAffected > 1 ? 's' : ''}`;
}

interface PanelProps {
  type: EventType;
  title: string;
  emptyHint: string;
}

export default function LivestockEventsPanel({ type, title, emptyHint }: PanelProps) {
  const [data, setData] = useState<LivestockEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fields, setFields] = useState<FieldOption[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [category, setCategory] = useState('');
  const [subtype, setSubtype] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');

  useEffect(() => {
    apiRequest<{ fields: FieldOption[] }>('/livestock/filters')
      .then(r => setFields(r.fields))
      .catch(() => {});
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ type, limit: '200' });
      if (fieldId) params.set('fieldId', fieldId);
      if (plotId) params.set('plotId', plotId);
      if (category) params.set('category', category);
      if (subtype) params.set('subtype', subtype);
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);
      const result = await apiRequest<ListResponse>(`/livestock/events?${params}`);
      setData(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  }, [type, fieldId, plotId, category, subtype, desde, hasta]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const hasFilters = !!(fieldId || plotId || category || subtype || desde || hasta);
  const clearFilters = () => {
    setFieldId(''); setPlotId(''); setCategory(''); setSubtype(''); setDesde(''); setHasta('');
  };

  const availablePlots = fieldId ? fields.find(f => f.id === Number(fieldId))?.plots ?? [] : [];

  // Type-specific aggregates
  const aggregates = useMemo(() => {
    if (data.length === 0) return null;
    if (type === 'weighing') {
      const weights = data.filter(e => e.quantity != null);
      const avgWeight = weights.length
        ? weights.reduce((a, e) => a + (e.quantity as number), 0) / weights.length
        : null;
      let gdpv: { value: number; days: number } | null = null;
      // GDPV: take 2 most recent weighings of the same category+location
      if (weights.length >= 2) {
        const sorted = [...weights].sort((a, b) => +new Date(b.eventDate) - +new Date(a.eventDate));
        const latest = sorted[0];
        const prev = sorted.find(e =>
          e !== latest &&
          e.category === latest.category &&
          (e.plotId ?? null) === (latest.plotId ?? null),
        );
        if (prev && latest.quantity && prev.quantity) {
          const days = Math.abs(Math.round((+new Date(latest.eventDate) - +new Date(prev.eventDate)) / 86_400_000));
          if (days > 0) gdpv = { value: ((latest.quantity - prev.quantity) / days), days };
        }
      }
      return {
        total: data.length,
        avgWeight: avgWeight != null ? Math.round(avgWeight) : null,
        gdpv,
      };
    }
    // health + repro
    const subtypes = new Set(data.map(e => e.subtype || '').filter(Boolean));
    const animalsTotal = data.reduce((a, e) => a + (e.animalsAffected || 0), 0);
    return {
      total: data.length,
      subtypes: subtypes.size,
      animalsTotal,
    };
  }, [data, type]);

  const subtypeOptions =
    type === 'health_event' ? HEALTH_LABELS :
    type === 'repro_event' ? REPRO_LABELS :
    null;

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-gray-800">{title}</h2>
      </div>

      {aggregates && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Eventos</div>
            <div className="text-lg font-semibold">{aggregates.total}</div>
          </div>
          {type === 'weighing' && 'avgWeight' in aggregates && (
            <>
              <div className="bg-gray-50 border border-gray-200 rounded p-3">
                <div className="text-xs text-gray-500">Peso promedio</div>
                <div className="text-lg font-semibold">{aggregates.avgWeight != null ? `${aggregates.avgWeight} kg` : '—'}</div>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded p-3 col-span-2">
                <div className="text-xs text-gray-500">GDPV (últimos 2)</div>
                <div className="text-lg font-semibold">
                  {aggregates.gdpv
                    ? `${aggregates.gdpv.value.toFixed(2)} kg/día (${aggregates.gdpv.days}d)`
                    : '—'}
                </div>
              </div>
            </>
          )}
          {type !== 'weighing' && 'animalsTotal' in aggregates && (
            <>
              <div className="bg-gray-50 border border-gray-200 rounded p-3">
                <div className="text-xs text-gray-500">Tipos distintos</div>
                <div className="text-lg font-semibold">{aggregates.subtypes}</div>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded p-3 col-span-2">
                <div className="text-xs text-gray-500">Animales totales</div>
                <div className="text-lg font-semibold">{aggregates.animalsTotal}</div>
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-gray-50 border border-gray-200 rounded mb-4 text-sm">
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Campo</label>
          <select value={fieldId}
            onChange={e => { setFieldId(e.target.value); setPlotId(''); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm">
            <option value="">Todos</option>
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Lote</label>
          <select value={plotId}
            onChange={e => setPlotId(e.target.value)}
            disabled={!fieldId}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm disabled:opacity-40">
            <option value="">Todos</option>
            {availablePlots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Categoría</label>
          <select value={category} onChange={e => setCategory(e.target.value)}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm">
            <option value="">Todas</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {subtypeOptions && (
          <div className="flex flex-col">
            <label className="text-xs text-gray-500 mb-1">Tipo</label>
            <select value={subtype} onChange={e => setSubtype(e.target.value)}
              className="border border-gray-300 rounded-md px-2 py-1.5 text-sm">
              <option value="">Todos</option>
              {Object.entries(subtypeOptions).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
        )}
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Desde</label>
          <input type="date" value={desde} onChange={e => setDesde(e.target.value)}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Hasta</label>
          <input type="date" value={hasta} onChange={e => setHasta(e.target.value)}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
        </div>
        {hasFilters && (
          <button onClick={clearFilters}
            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline py-1.5">
            Limpiar
          </button>
        )}
      </div>

      {loading && data.length === 0 && <div className="text-sm text-gray-500">Cargando…</div>}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3 mb-3">
          {error} <button onClick={fetchData} className="ml-2 underline">Reintentar</button>
        </div>
      )}

      {!loading && data.length === 0 && !error && (
        <div className="text-sm text-gray-500 bg-gray-50 rounded p-6 text-center border border-dashed border-gray-300">
          {emptyHint}
        </div>
      )}

      {data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3">Fecha</th>
                {type === 'weighing' ? (
                  <>
                    <th className="py-2 pr-3 text-right">Peso prom</th>
                    <th className="py-2 pr-3">Animales</th>
                  </>
                ) : (
                  <>
                    <th className="py-2 pr-3">Tipo</th>
                    <th className="py-2 pr-3">{type === 'health_event' ? 'Vacuna / Producto' : 'Toro / Detalle'}</th>
                    <th className="py-2 pr-3">Animales</th>
                    {type === 'health_event' && <th className="py-2 pr-3 hidden md:table-cell">Dosis</th>}
                    {type === 'repro_event' && <th className="py-2 pr-3 hidden md:table-cell">Método</th>}
                    {type === 'health_event' && <th className="py-2 pr-3 hidden lg:table-cell">Veterinario</th>}
                  </>
                )}
                <th className="py-2 pr-3">Ubicación</th>
                <th className="py-2 pr-3 hidden lg:table-cell">Notas</th>
              </tr>
            </thead>
            <tbody>
              {data.map(e => (
                <tr key={e.id} className="border-b border-gray-100 hover:bg-gray-50 align-top">
                  <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">{fmtDate(e.eventDate)}</td>
                  {type === 'weighing' ? (
                    <>
                      <td className="py-2 pr-3 text-right font-medium text-gray-800 whitespace-nowrap">
                        {e.quantity != null ? `${e.quantity} kg` : '—'}
                      </td>
                      <td className="py-2 pr-3 text-gray-700">{describeAnimals(e)}</td>
                    </>
                  ) : (
                    <>
                      <td className="py-2 pr-3 text-gray-800">
                        {(() => {
                          const opts = type === 'health_event' ? HEALTH_LABELS : REPRO_LABELS;
                          const meta = e.subtype ? opts[e.subtype] : null;
                          if (!meta) return e.subtype || '—';
                          const Icon = meta.Icon;
                          return (
                            <span className="inline-flex items-center gap-1">
                              <Icon className="w-3.5 h-3.5" />
                              {meta.label}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="py-2 pr-3 text-gray-700">{e.product || <span className="text-gray-300">—</span>}</td>
                      <td className="py-2 pr-3 text-gray-700">{describeAnimals(e)}</td>
                      {type === 'health_event' && (
                        <td className="py-2 pr-3 text-gray-600 hidden md:table-cell">
                          {e.quantity != null && e.unit ? `${e.quantity} ${e.unit}` : <span className="text-gray-300">—</span>}
                        </td>
                      )}
                      {type === 'repro_event' && (
                        <td className="py-2 pr-3 text-gray-600 hidden md:table-cell">
                          {e.implement || <span className="text-gray-300">—</span>}
                        </td>
                      )}
                      {type === 'health_event' && (
                        <td className="py-2 pr-3 text-gray-500 text-xs hidden lg:table-cell">
                          {e.implement || <span className="text-gray-300">—</span>}
                        </td>
                      )}
                    </>
                  )}
                  <td className="py-2 pr-3 text-gray-600">{describeLocation(e)}</td>
                  <td className="py-2 pr-3 text-gray-500 text-xs hidden lg:table-cell">
                    {e.notes ? <span className="italic">{e.notes}</span> : <span className="text-gray-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
