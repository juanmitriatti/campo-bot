import { useEffect, useState, useCallback, useMemo } from 'react';
import { apiRequest } from '../api/client';

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

  const limit = 50;

  useEffect(() => {
    apiRequest<{ fields: FieldOption[] }>('/observations/filters')
      .then(r => setFields(r.fields))
      .catch(() => {});
  }, []);

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
      const result = await apiRequest<PaginatedResponse>(`/harvest-loads?${params}`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar cosechas');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, dateFrom, dateTo, driver, destinatario]);

  useEffect(() => { fetchLoads(); }, [fetchLoads]);

  const hasFilters = !!(fieldId || plotId || dateFrom || dateTo || driver || destinatario);
  const clearFilters = () => {
    setFieldId(''); setPlotId(''); setDateFrom(''); setDateTo('');
    setDriver(''); setDestinatario(''); setPage(1);
  };

  const availablePlots = fieldId ? fields.find(f => f.id === Number(fieldId))?.plots ?? [] : [];

  // Aggregates over the visible rows
  const aggregates = useMemo(() => {
    if (!data?.data?.length) return null;
    const totalKg = data.data.reduce((acc, l) => acc + l.weightKg, 0);
    const trips = data.data.length;
    const drivers = new Set(data.data.map(l => l.driverName.toLowerCase().trim()));
    const humidities = data.data.filter(l => l.humidityPct != null);
    const avgHumidity = humidities.length
      ? humidities.reduce((a, l) => a + (l.humidityPct as number), 0) / humidities.length
      : null;
    return {
      totalKg,
      trips,
      drivers: drivers.size,
      avgHumidity: avgHumidity != null ? Math.round(avgHumidity * 10) / 10 : null,
    };
  }, [data]);

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-gray-800">Cosechas — cargas por camión</h2>
        <span className="text-xs text-gray-400">Chofer · kg · destinatario · humedad · calidad</span>
      </div>

      {aggregates && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Cargas (pág.)</div>
            <div className="text-lg font-semibold">{aggregates.trips}</div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Total (pág.)</div>
            <div className="text-lg font-semibold">{formatKg(aggregates.totalKg)}</div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Choferes</div>
            <div className="text-lg font-semibold">{aggregates.drivers}</div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-xs text-gray-500">Humedad prom</div>
            <div className="text-lg font-semibold">{aggregates.avgHumidity != null ? `${aggregates.avgHumidity}%` : '—'}</div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-gray-50 border border-gray-200 rounded mb-4 text-sm">
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Desde</label>
          <input type="date" value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Hasta</label>
          <input type="date" value={dateTo}
            onChange={e => { setDateTo(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Campo</label>
          <select value={fieldId}
            onChange={e => { setFieldId(e.target.value); setPlotId(''); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm">
            <option value="">Todos</option>
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Lote</label>
          <select value={plotId}
            onChange={e => { setPlotId(e.target.value); setPage(1); }}
            disabled={!fieldId}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm disabled:opacity-40">
            <option value="">Todos</option>
            {availablePlots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Chofer</label>
          <input type="text" value={driver}
            onChange={e => { setDriver(e.target.value); setPage(1); }}
            placeholder="Nombre"
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm w-32" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Destinatario</label>
          <input type="text" value={destinatario}
            onChange={e => { setDestinatario(e.target.value); setPage(1); }}
            placeholder="Acopio / Cargill…"
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm w-40" />
        </div>
        {hasFilters && (
          <button onClick={clearFilters}
            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline py-1.5">
            Limpiar
          </button>
        )}
      </div>

      {loading && !data && <div className="text-sm text-gray-500">Cargando cosechas…</div>}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3 mb-3">
          {error} <button onClick={fetchLoads} className="ml-2 underline">Reintentar</button>
        </div>
      )}

      {!loading && data && data.data.length === 0 && !error && (
        <div className="text-sm text-gray-500 bg-gray-50 rounded p-6 text-center border border-dashed border-gray-300">
          No hay cargas de cosecha. Pedile al bot:<br />
          <span className="font-mono text-gray-700">"coseché lote norte: Juan 28000kg al 14% hum, Pedro 31000kg para Cargill"</span>
        </div>
      )}

      {data && data.data.length > 0 && (
        <div className="overflow-x-auto bg-white rounded-lg shadow-sm border border-gray-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Fecha</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Lote / Cultivo</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Chofer</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Peso</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Hum.</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Calidad</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Destinatario</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Camión</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.data.map(l => (
                <tr key={l.id} className="hover:bg-gray-50 transition-colors align-top">
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{formatDate(l.eventDate)}</td>
                  <td className="px-4 py-3 text-gray-800">
                    <div className="font-medium">{l.plotName || <span className="text-gray-300">—</span>}</div>
                    <div className="text-xs text-gray-400">
                      {l.fieldName && <span>{l.fieldName}</span>}
                      {l.crop && <span> · {l.crop}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{l.driverName}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-gray-800">{formatKg(l.weightKg)}</td>
                  <td className="px-4 py-3 text-right text-gray-600 hidden md:table-cell">
                    {l.humidityPct != null ? `${l.humidityPct}%` : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs hidden lg:table-cell">
                    {describeQuality(l.qualityMetrics) || <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                    {l.destinatario || l.destination || <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs hidden lg:table-cell">
                    {l.truckPlate || <span className="text-gray-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <p className="text-sm text-gray-500">{data.total} cargas en total</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40">
                  Anterior
                </button>
                <span className="text-sm text-gray-600">{page} / {data.totalPages}</span>
                <button onClick={() => setPage(p => Math.min(data.totalPages, p + 1))} disabled={page >= data.totalPages}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40">
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
