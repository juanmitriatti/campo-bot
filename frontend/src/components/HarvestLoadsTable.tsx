import { useEffect, useState, useCallback } from 'react';
import { useSortableTable } from '../hooks/useSortableTable';
import { apiRequest } from '../api/client';
import TabHeader from './TabHeader';

interface QualityMetrics {
  oil_pct?: number;
  protein_pct?: number;
  gluten_pct?: number;
  test_weight_kg_hl?: number;
}

interface HarvestLoad {
  id: number;
  driverName: string;
  weightKg: number;
  destination: string | null;
  destinatario: string | null;
  truckPlate: string | null;
  notes: string | null;
  humidityPct: number | null;
  qualityMetrics: QualityMetrics | null;
  eventId: number;
  eventDate: string;
  crop: string | null;
  plotId: number | null;
  plotName: string | null;
  fieldId: number | null;
  fieldName: string | null;
  plotHectares: number | null;
}

interface PaginatedResponse {
  data: HarvestLoad[];
  total: number;
  page: number;
  totalPages: number;
}

interface PlotOption { id: number; name: string }
interface FieldOption { id: number; name: string; plots: PlotOption[] }

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function formatKg(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} tn`;
  return `${kg.toLocaleString('es-AR')} kg`;
}

function describeQuality(q: QualityMetrics | null): string {
  if (!q) return '';
  const parts: string[] = [];
  if (q.oil_pct != null) parts.push(`aceite ${q.oil_pct}%`);
  if (q.protein_pct != null) parts.push(`prot ${q.protein_pct}%`);
  if (q.gluten_pct != null) parts.push(`gluten ${q.gluten_pct}%`);
  if (q.test_weight_kg_hl != null) parts.push(`PH ${q.test_weight_kg_hl} kg/hl`);
  return parts.join(' · ');
}

export default function HarvestLoadsTable() {
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fields, setFields] = useState<FieldOption[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [driver, setDriver] = useState('');
  const [destinatario, setDestinatario] = useState('');
  const [cropFilter, setCropFilter] = useState('');
  const [humMin, setHumMin] = useState('');
  const [humMax, setHumMax] = useState('');

  const limit = 50;

  useEffect(() => {
    apiRequest<{ fields: FieldOption[] }>('/observations/filters')
      .then(r => {
        setFields(r.fields);
        if (r.fields.length === 1) setFieldId(String(r.fields[0].id));
      })
      .catch(() => {});
  }, []);

  // Auto-pick the only plot if there's just one (within active field)
  useEffect(() => {
    const allPlots = fields.flatMap(f => f.plots);
    const candidatePlots = fieldId
      ? fields.find(f => f.id === Number(fieldId))?.plots ?? []
      : allPlots;
    if (candidatePlots.length === 1 && !plotId) {
      setPlotId(String(candidatePlots[0].id));
    }
  }, [fields, fieldId, plotId]);

  const fetchLoads = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (fieldId) params.set('fieldId', fieldId);
      if (plotId) params.set('plotId', plotId);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (driver) params.set('driver', driver);
      if (destinatario) params.set('destinatario', destinatario);
      if (cropFilter) params.set('crop', cropFilter);
      if (humMin) params.set('humidityMin', humMin);
      if (humMax) params.set('humidityMax', humMax);
      const result = await apiRequest<PaginatedResponse>(`/harvest-loads?${params}`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar cosechas');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, dateFrom, dateTo, driver, destinatario, cropFilter, humMin, humMax]);

  useEffect(() => { fetchLoads(); }, [fetchLoads]);

  const hasFilters = !!(fieldId || plotId || dateFrom || dateTo || driver || destinatario || cropFilter || humMin || humMax);
  const clearFilters = () => {
    setFieldId(fields.length === 1 ? String(fields[0].id) : '');
    setPlotId(''); setDateFrom(''); setDateTo('');
    setDriver(''); setDestinatario('');
    setCropFilter(''); setHumMin(''); setHumMax('');
    setPage(1);
  };

  const availablePlots = fieldId ? fields.find(f => f.id === Number(fieldId))?.plots ?? [] : [];

  // Client-side filter (cultivo, humedad range) + sort
  const filteredLoads = (data?.data ?? []).filter(l => {
    if (cropFilter && (l.crop || '').toLowerCase() !== cropFilter.toLowerCase()) return false;
    if (humMin && (l.humidityPct == null || l.humidityPct < Number(humMin))) return false;
    if (humMax && (l.humidityPct == null || l.humidityPct > Number(humMax))) return false;
    return true;
  });
  const cropsAvailable = [...new Set((data?.data ?? []).map(l => l.crop).filter(Boolean) as string[])];

  const { sorted: sortedLoads, toggleSort, arrow } = useSortableTable<typeof filteredLoads[0], 'date' | 'plot' | 'crop' | 'driver' | 'weight' | 'humidity' | 'destinatario' | 'truck'>(filteredLoads, {
    getValue: (row, key) => {
      switch (key) {
        case 'date': return row.eventDate;
        case 'plot': return (row.plotName || '').toLowerCase();
        case 'crop': return (row.crop || '').toLowerCase();
        case 'driver': return (row.driverName || '').toLowerCase();
        case 'weight': return Number(row.weightKg);
        case 'humidity': return row.humidityPct == null ? null : Number(row.humidityPct);
        case 'destinatario': return (row.destinatario || '').toLowerCase();
        case 'truck': return (row.truckPlate || '').toLowerCase();
      }
    },
    initial: { key: 'date', direction: 'desc' },
  });

  return (
    <div className="p-4 md:p-6">
      <TabHeader
        title="Cosechas"
        description="Cada camión que salió: chofer, kilos, humedad, destino."
        botHint="cosechamos el lote 3: Ramírez 28.500 kg a Cargill"
      />

      <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded mb-4 text-sm">
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Desde</label>
          <input type="date" value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Hasta</label>
          <input type="date" value={dateTo}
            onChange={e => { setDateTo(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Campo</label>
          <select value={fieldId}
            onChange={e => { setFieldId(e.target.value); setPlotId(''); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm">
            {fields.length !== 1 && <option value="">Todos</option>}
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Lote</label>
          <select value={plotId}
            onChange={e => { setPlotId(e.target.value); setPage(1); }}
            disabled={!fieldId}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm disabled:opacity-40">
            {availablePlots.length !== 1 && <option value="">Todos</option>}
            {availablePlots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Chofer</label>
          <input type="text" value={driver}
            onChange={e => { setDriver(e.target.value); setPage(1); }}
            placeholder="Nombre"
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm w-32" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Destinatario</label>
          <input type="text" value={destinatario}
            onChange={e => { setDestinatario(e.target.value); setPage(1); }}
            placeholder="Acopio / Cargill…"
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm w-40" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Cultivo</label>
          <select value={cropFilter}
            onChange={e => setCropFilter(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm">
            <option value="">Todos</option>
            {cropsAvailable.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Humedad mín %</label>
          <input type="number" step="0.1" value={humMin}
            onChange={e => setHumMin(e.target.value)}
            placeholder="0"
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm w-20" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Humedad máx %</label>
          <input type="number" step="0.1" value={humMax}
            onChange={e => setHumMax(e.target.value)}
            placeholder="∞"
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm w-20" />
        </div>
        {hasFilters && (
          <button onClick={clearFilters}
            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline py-1.5">
            Limpiar
          </button>
        )}
      </div>

      {loading && !data && <div className="text-sm text-gray-500 dark:text-gray-300">Cargando cosechas…</div>}

      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded p-3 mb-3">
          {error} <button onClick={fetchLoads} className="ml-2 underline">Reintentar</button>
        </div>
      )}

      {!loading && data && data.data.length === 0 && !error && (
        <div className="text-sm text-gray-500 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 rounded p-6 text-center border border-dashed border-gray-300 dark:border-gray-600">
          No hay cargas de cosecha. Pedile al bot:<br />
          <span className="font-mono text-gray-700 dark:text-gray-200">"coseché lote norte: Juan 28000kg al 14% hum, Pedro 31000kg para Cargill"</span>
        </div>
      )}

      {data && data.data.length > 0 && (
        <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                <th onClick={() => toggleSort('date')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Fecha{arrow('date')}</th>
                <th onClick={() => toggleSort('plot')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Lote / Cultivo{arrow('plot')}</th>
                <th onClick={() => toggleSort('driver')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Chofer{arrow('driver')}</th>
                <th onClick={() => toggleSort('weight')} className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Peso{arrow('weight')}</th>
                <th onClick={() => toggleSort('humidity')} className="text-right px-4 py-3 font-medium text-gray-600 hidden md:table-cell cursor-pointer select-none hover:bg-gray-100">Hum.{arrow('humidity')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden lg:table-cell">Calidad</th>
                <th onClick={() => toggleSort('destinatario')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden md:table-cell cursor-pointer select-none hover:bg-gray-100">Destinatario{arrow('destinatario')}</th>
                <th onClick={() => toggleSort('truck')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden lg:table-cell cursor-pointer select-none hover:bg-gray-100">Camión{arrow('truck')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {sortedLoads.map(l => (
                <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors align-top">
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-300 text-sm whitespace-nowrap">{formatDate(l.eventDate)}</td>
                  <td className="px-4 py-3 text-gray-800 dark:text-gray-100">
                    <div className="font-medium">{l.plotName || <span className="text-gray-300 dark:text-gray-600">—</span>}</div>
                    <div className="text-xs text-gray-400 dark:text-gray-300">
                      {l.fieldName && <span>{l.fieldName}</span>}
                      {l.crop && <span> · {l.crop}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-700 dark:text-gray-200">{l.driverName}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-gray-800 dark:text-gray-100">{formatKg(l.weightKg)}</td>
                  <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-300 hidden md:table-cell">
                    {l.humidityPct != null ? `${l.humidityPct}%` : <span className="text-gray-300 dark:text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs hidden lg:table-cell">
                    {describeQuality(l.qualityMetrics) || <span className="text-gray-300 dark:text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 hidden md:table-cell">
                    {l.destinatario ? (
                      <>
                        {l.destinatario}
                        {l.destination && l.destination !== l.destinatario && (
                          <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">· {l.destination.replace(/_/g, ' ')}</span>
                        )}
                      </>
                    ) : l.destination ? (
                      <span className="text-gray-500 dark:text-gray-400">{l.destination.replace(/_/g, ' ')}</span>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-300 text-sm hidden lg:table-cell">
                    {l.truckPlate || <span className="text-gray-300 dark:text-gray-600">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
              <p className="text-sm text-gray-500">{data.total} cargas en total</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:text-gray-200 dark:bg-gray-800 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40">
                  Anterior
                </button>
                <span className="text-sm text-gray-600 dark:text-gray-300">{page} / {data.totalPages}</span>
                <button onClick={() => setPage(p => Math.min(data.totalPages, p + 1))} disabled={page >= data.totalPages}
                  className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:text-gray-200 dark:bg-gray-800 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40">
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
