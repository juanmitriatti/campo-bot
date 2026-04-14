import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import ObservationEditModal from './ObservationEditModal';
import ObservationCard from './cards/ObservationCard';
import { useIsMobile } from '../hooks/useIsMobile';

interface Observation {
  id: number;
  observation_text: string;
  category: string;
  source: string;
  created_at: string;
  updated_at: string | null;
  plot_name: string | null;
  field_name: string | null;
  user_name: string | null;
}

interface PaginatedResponse {
  observations: Observation[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface PlotOption {
  id: number;
  name: string;
}

interface FieldOption {
  id: number;
  name: string;
  plots: PlotOption[];
}

interface FiltersResponse {
  fields: FieldOption[];
}

const CATEGORY_LABELS: Record<string, string> = {
  sanidad: 'Sanidad',
  malezas: 'Malezas',
  nutricion: 'Nutrición',
  fenologia: 'Fenología',
  clima: 'Clima',
  general: 'General',
};

export default function ObservationTable() {
  const isMobile = useIsMobile();
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Observation | null>(null);

  // Filter state
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const limit = 10;

  // Load filter options once
  useEffect(() => {
    apiRequest<FiltersResponse>('/observations/filters')
      .then(r => setFields(r.fields))
      .catch(() => {});
  }, []);

  const fetchObservations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (fieldId) params.set('fieldId', fieldId);
      if (plotId) params.set('plotId', plotId);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      const result = await apiRequest<PaginatedResponse>(`/observations?${params}`);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar observaciones');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, dateFrom, dateTo]);

  useEffect(() => {
    fetchObservations();
  }, [fetchObservations]);

  const handleSaved = () => {
    setEditing(null);
    fetchObservations();
  };

  const handleFieldChange = (val: string) => {
    setFieldId(val);
    setPlotId('');
    setPage(1);
  };

  const clearFilters = () => {
    setFieldId('');
    setPlotId('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  const hasFilters = fieldId || plotId || dateFrom || dateTo;

  const availablePlots = fieldId
    ? fields.find(f => f.id === Number(fieldId))?.plots ?? []
    : [];

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading && !data) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700 text-sm">
        {error}
        <button onClick={fetchObservations} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-gray-50 border-b border-gray-200 text-sm">
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Desde</label>
          <input
            type="date"
            value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Hasta</label>
          <input
            type="date"
            value={dateTo}
            onChange={e => { setDateTo(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Campo</label>
          <select
            value={fieldId}
            onChange={e => handleFieldChange(e.target.value)}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todos</option>
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Lote</label>
          <select
            value={plotId}
            onChange={e => { setPlotId(e.target.value); setPage(1); }}
            disabled={!fieldId}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm disabled:opacity-40"
          >
            <option value="">Todos</option>
            {availablePlots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline py-1.5"
          >
            Limpiar
          </button>
        )}
      </div>

      {/* Content */}
      {!data || data.observations.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg">{hasFilters ? 'No hay observaciones con estos filtros' : 'No tenes observaciones todavia'}</p>
          {!hasFilters && <p className="text-sm mt-1">Las observaciones que registres por WhatsApp apareceran aca</p>}
        </div>
      ) : (
        <>
          {isMobile ? (
            <div className="space-y-3 p-4">
              {data.observations.map(obs => (
                <ObservationCard key={obs.id} observation={obs} onEdit={setEditing} />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Observacion</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Campo</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Lote</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Categoria</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Creada</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Registrado por</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Editada</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.observations.map(obs => (
                    <tr key={obs.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 max-w-xs">
                        <p className="truncate text-gray-800">{obs.observation_text}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {obs.field_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {obs.plot_name || '-'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block bg-campo-100 text-campo-800 text-xs px-2 py-0.5 rounded">
                          {CATEGORY_LABELS[obs.category] || obs.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {formatDate(obs.created_at)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden lg:table-cell whitespace-nowrap">
                        {obs.user_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {obs.updated_at ? formatDate(obs.updated_at) : '-'}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setEditing(obs)}
                          className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline"
                        >
                          Editar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <p className="text-sm text-gray-500">
                {data.total} observaciones en total
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Anterior
                </button>
                <span className="text-sm text-gray-600">
                  {page} / {data.totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                  disabled={page >= data.totalPages}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Edit modal */}
      {editing && (
        <ObservationEditModal
          observation={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
