import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import ObservationEditModal from './ObservationEditModal';

interface Observation {
  id: number;
  observation_text: string;
  category: string;
  source: string;
  created_at: string;
  updated_at: string | null;
  plot_name: string | null;
  field_name: string | null;
}

interface PaginatedResponse {
  observations: Observation[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
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
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Observation | null>(null);

  const limit = 10;

  const fetchObservations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<PaginatedResponse>(`/observations?page=${page}&limit=${limit}`);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar observaciones');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchObservations();
  }, [fetchObservations]);

  const handleSaved = () => {
    setEditing(null);
    fetchObservations();
  };

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

  if (!data || data.observations.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p className="text-lg">No tenés observaciones todavía</p>
        <p className="text-sm mt-1">Las observaciones que registres por WhatsApp aparecerán acá</p>
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Observación</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Lote</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Categoría</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Creada</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Editada</th>
              <th className="px-4 py-3 w-20" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.observations.map(obs => (
              <tr key={obs.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 max-w-xs">
                  <p className="truncate text-gray-800">{obs.observation_text}</p>
                  <p className="text-xs text-gray-400 sm:hidden">
                    {obs.plot_name && `${obs.plot_name} · `}
                    {CATEGORY_LABELS[obs.category] || obs.category}
                  </p>
                </td>
                <td className="px-4 py-3 text-gray-600 hidden sm:table-cell">
                  {obs.plot_name || '-'}
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <span className="inline-block bg-campo-100 text-campo-800 text-xs px-2 py-0.5 rounded">
                    {CATEGORY_LABELS[obs.category] || obs.category}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                  {formatDate(obs.created_at)}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap hidden sm:table-cell">
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
