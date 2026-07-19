import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import ObservationEditModal from './ObservationEditModal';
import ObservationCard from './cards/ObservationCard';
import { useIsMobile } from '../hooks/useIsMobile';
import { useSortableTable } from '../hooks/useSortableTable';
import TabHeader from './TabHeader';

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
  const [obsSearch, setObsSearch] = useState('');

  const limit = 10;

  // Load filter options once
  useEffect(() => {
    apiRequest<FiltersResponse>('/observations/filters')
      .then(r => {
        setFields(r.fields);
        if (r.fields.length === 1) setFieldId(String(r.fields[0].id));
      })
      .catch(() => {});
  }, []);

  // Auto-pick the only plot when there's just one
  useEffect(() => {
    const allPlots = fields.flatMap(f => f.plots);
    const candidatePlots = fieldId
      ? fields.find(f => f.id === Number(fieldId))?.plots ?? []
      : allPlots;
    if (candidatePlots.length === 1 && !plotId) {
      setPlotId(String(candidatePlots[0].id));
    }
  }, [fields, fieldId, plotId]);

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
    setFieldId(fields.length === 1 ? String(fields[0].id) : '');
    setPlotId('');
    setDateFrom('');
    setDateTo('');
    setObsSearch('');
    setPage(1);
  };

  const hasFilters = fieldId || plotId || dateFrom || dateTo || obsSearch.trim();

  const filteredObservations = (data?.observations ?? []).filter(o => {
    if (!obsSearch.trim()) return true;
    return o.observation_text.toLowerCase().includes(obsSearch.trim().toLowerCase());
  });

  const { sorted: sortedObservations, toggleSort, arrow } = useSortableTable<typeof filteredObservations[0], 'date' | 'category' | 'observation' | 'field' | 'plot'>(filteredObservations, {
    getValue: (row, key) => {
      switch (key) {
        case 'date': return row.created_at;
        case 'category': return row.category;
        case 'observation': return row.observation_text.toLowerCase();
        case 'field': return (row.field_name || '').toLowerCase();
        case 'plot': return (row.plot_name || '').toLowerCase();
      }
    },
    initial: { key: 'date', direction: 'desc' },
  });

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
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4 text-red-700 dark:text-red-300 text-sm">
        {error}
        <button onClick={fetchObservations} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  return (
    <div>
      <TabHeader
        title="Observaciones"
        description="Notas libres sobre lo que ves en el campo — el bot las guarda con fecha y lote."
        botHint="observación: apareció pulgón en la loma del 5"
      />
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 text-sm">
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Desde</label>
          <input
            type="date"
            value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Hasta</label>
          <input
            type="date"
            value={dateTo}
            onChange={e => { setDateTo(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Campo</label>
          <select
            value={fieldId}
            onChange={e => handleFieldChange(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          >
            {fields.length !== 1 && <option value="">Todos</option>}
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Lote</label>
          <select
            value={plotId}
            onChange={e => { setPlotId(e.target.value); setPage(1); }}
            disabled={!fieldId}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm disabled:opacity-40"
          >
            {availablePlots.length !== 1 && <option value="">Todos</option>}
            {availablePlots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Observación</label>
          <input
            type="text"
            placeholder="Buscar texto..."
            value={obsSearch}
            onChange={e => setObsSearch(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm min-w-[180px]"
          />
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
        <div className="text-sm text-gray-500 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 rounded p-6 text-center border border-dashed border-gray-300 dark:border-gray-600">
          {hasFilters ? 'No hay observaciones con estos filtros.' : (
            <>No hay observaciones. Mandale al bot:<br />
            <span className="font-mono text-gray-700 dark:text-gray-200">"observación: apareció pulgón en la loma del 5"</span><br />
            <span className="text-xs">— o simplemente contale lo que ves en el campo.</span></>
          )}
        </div>
      ) : (
        <>
          {isMobile ? (
            <div className="space-y-3 p-4">
              {sortedObservations.map(obs => (
                <ObservationCard key={obs.id} observation={obs} onEdit={setEditing} />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                    <th onClick={() => toggleSort('observation')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Observacion{arrow('observation')}</th>
                    <th onClick={() => toggleSort('field')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Campo{arrow('field')}</th>
                    <th onClick={() => toggleSort('plot')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Lote{arrow('plot')}</th>
                    <th onClick={() => toggleSort('category')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Categoria{arrow('category')}</th>
                    <th onClick={() => toggleSort('date')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Creada{arrow('date')}</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden lg:table-cell">Registrado por</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">Editada</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedObservations.map(obs => (
                    <tr key={obs.id} className="hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                      <td className="px-4 py-3 max-w-xs">
                        <p className="truncate text-gray-800 dark:text-gray-100">{obs.observation_text}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {obs.field_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {obs.plot_name || '-'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block bg-campo-100 text-campo-800 text-xs px-2 py-0.5 rounded">
                          {CATEGORY_LABELS[obs.category] || obs.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-300 text-sm whitespace-nowrap">
                        {formatDate(obs.created_at)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-300 text-sm hidden lg:table-cell whitespace-nowrap">
                        {obs.user_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-300 text-sm whitespace-nowrap">
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
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
              <p className="text-sm text-gray-500 dark:text-gray-300">
                {data.total} observaciones en total
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:text-gray-200 dark:bg-gray-800 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Anterior
                </button>
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  {page} / {data.totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                  disabled={page >= data.totalPages}
                  className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:text-gray-200 dark:bg-gray-800 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
