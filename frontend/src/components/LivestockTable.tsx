import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import LivestockMovementHistory from './LivestockMovementHistory';
import LivestockEditModal from './LivestockEditModal';

interface LivestockGroup {
  id: string;
  user_id: number;
  field_id: number;
  plot_id: number;
  category: string;
  breed: string | null;
  count: number;
  avg_weight_kg: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  field_name: string;
  plot_name: string;
}

interface PaginatedResponse {
  items: LivestockGroup[];
  totalAnimals: number;
  totalGroups: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface FieldOption {
  id: number;
  name: string;
  plots: { id: number; name: string }[];
}

interface FiltersResponse {
  fields: FieldOption[];
  categories: string[];
}

const CATEGORY_LABELS: Record<string, string> = {
  vaca: 'Vaca',
  vaquillona: 'Vaquillona',
  ternero: 'Ternero',
  ternera: 'Ternera',
  novillo: 'Novillo',
  novillito: 'Novillito',
  toro: 'Toro',
  torito: 'Torito',
  buey: 'Buey',
};

export default function LivestockTable() {
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewingMovements, setViewingMovements] = useState<LivestockGroup | null>(null);
  const [editing, setEditing] = useState<LivestockGroup | null>(null);

  const [fields, setFields] = useState<FieldOption[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [category, setCategory] = useState('');

  const limit = 15;

  useEffect(() => {
    apiRequest<FiltersResponse>('/livestock/filters')
      .then(r => setFields(r.fields))
      .catch(() => {});
  }, []);

  const fetchLivestock = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (fieldId) params.set('fieldId', fieldId);
      if (plotId) params.set('plotId', plotId);
      if (category) params.set('category', category);
      const result = await apiRequest<PaginatedResponse>(`/livestock?${params}`);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar hacienda');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, category]);

  useEffect(() => {
    fetchLivestock();
  }, [fetchLivestock]);

  const handleSaved = () => {
    setEditing(null);
    fetchLivestock();
  };

  const hasFilters = !!fieldId || !!plotId || !!category;

  // Plots filtered by selected field
  const plotsForField = fieldId
    ? fields.find(f => String(f.id) === fieldId)?.plots ?? []
    : [];

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
        <button onClick={fetchLivestock} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-gray-50 border-b border-gray-200 text-sm">
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Campo</label>
          <select
            value={fieldId}
            onChange={e => { setFieldId(e.target.value); setPlotId(''); setPage(1); }}
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
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm disabled:bg-gray-100"
          >
            <option value="">Todos</option>
            {plotsForField.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Categoría</label>
          <select
            value={category}
            onChange={e => { setCategory(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todas</option>
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
        {hasFilters && (
          <button
            onClick={() => { setFieldId(''); setPlotId(''); setCategory(''); setPage(1); }}
            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline py-1.5"
          >
            Limpiar
          </button>
        )}
      </div>

      {/* Totals banner */}
      {data && data.items.length > 0 && (
        <div className="px-4 py-2 bg-campo-50 border-b border-campo-100 text-sm text-campo-800">
          Total: <strong>{data.totalAnimals}</strong> animales en <strong>{data.totalGroups}</strong> {data.totalGroups === 1 ? 'grupo' : 'grupos'}
        </div>
      )}

      {/* Table */}
      {!data || data.items.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg">{hasFilters ? 'No hay hacienda con estos filtros' : 'No tenés hacienda registrada'}</p>
          {!hasFilters && <p className="text-sm mt-1">Cargá animales por WhatsApp o Telegram con "agregué 20 vacas al lote norte"</p>}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Categoría</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Cantidad</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Lote</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Campo</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Raza</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Peso prom.</th>
                  <th className="px-4 py-3 w-32" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.items.map(group => (
                  <tr key={group.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="text-gray-800 font-medium">{CATEGORY_LABELS[group.category] || group.category}</p>
                      <p className="text-xs text-gray-400 sm:hidden">
                        {group.plot_name} · {group.field_name}
                        {group.breed && ` · ${group.breed}`}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-800">
                      {group.count}
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden sm:table-cell">{group.plot_name}</td>
                    <td className="px-4 py-3 text-gray-600 hidden md:table-cell">{group.field_name}</td>
                    <td className="px-4 py-3 text-gray-600 hidden lg:table-cell">
                      {group.breed || <span className="text-gray-300">-</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600 hidden lg:table-cell">
                      {group.avg_weight_kg != null
                        ? <span>{group.avg_weight_kg} kg</span>
                        : <span className="text-gray-300">-</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => setViewingMovements(group)}
                          className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline"
                        >
                          Movimientos
                        </button>
                        <button
                          onClick={() => setEditing(group)}
                          className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline"
                        >
                          Editar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <p className="text-sm text-gray-500">{data.totalGroups} grupos en total</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Anterior
                </button>
                <span className="text-sm text-gray-600">{page} / {data.totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                  disabled={page >= data.totalPages}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {viewingMovements && (
        <LivestockMovementHistory
          group={viewingMovements}
          onClose={() => setViewingMovements(null)}
        />
      )}
      {editing && (
        <LivestockEditModal
          group={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
