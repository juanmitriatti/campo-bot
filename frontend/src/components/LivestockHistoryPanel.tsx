import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import {
  ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight, Skull, Egg,
  Repeat, BarChart3, Square,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface Movement {
  id: string;
  user_id: number;
  movement_type: string;
  source_group_id: string | null;
  dest_group_id: string | null;
  count: number;
  avg_weight_kg: number | null;
  unit_price_ars: number | null;
  unit_price_usd: number | null;
  reason: string | null;
  notes: string | null;
  movement_date: string;
  created_at: string;
  source_category: string | null;
  source_breed: string | null;
  source_plot_name: string | null;
  source_field_name: string | null;
  source_corral_name: string | null;
  source_feedlot_name: string | null;
  dest_category: string | null;
  dest_breed: string | null;
  dest_plot_name: string | null;
  dest_field_name: string | null;
  dest_corral_name: string | null;
  dest_feedlot_name: string | null;
  linked_expense_id: number | null;
  linked_income_id: number | null;
}

interface PaginatedResponse {
  items: Movement[];
  total: number;
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
  vaca: 'Vaca', vaquillona: 'Vaquillona', ternero: 'Ternero', ternera: 'Ternera',
  novillo: 'Novillo', novillito: 'Novillito', toro: 'Toro', torito: 'Torito', buey: 'Buey',
};

const TYPE_LABELS: Record<string, { Icon: LucideIcon; label: string; color: string }> = {
  entrada: { Icon: ArrowDownToLine, label: 'Entrada', color: 'bg-green-100 text-green-800' },
  salida: { Icon: ArrowUpFromLine, label: 'Salida', color: 'bg-red-100 text-red-800' },
  transferencia: { Icon: ArrowLeftRight, label: 'Transferencia', color: 'bg-blue-100 text-blue-800' },
  muerte: { Icon: Skull, label: 'Muerte', color: 'bg-gray-200 text-gray-800' },
  nacimiento: { Icon: Egg, label: 'Nacimiento', color: 'bg-yellow-100 text-yellow-800' },
  recategorizacion: { Icon: Repeat, label: 'Recategorización', color: 'bg-purple-100 text-purple-800' },
  ajuste: { Icon: BarChart3, label: 'Ajuste', color: 'bg-indigo-100 text-indigo-800' },
};

const MOVEMENT_TYPES = Object.keys(TYPE_LABELS);

function describeEndpoint(m: Movement, which: 'source' | 'dest'): string | null {
  const cat = which === 'source' ? m.source_category : m.dest_category;
  const plot = which === 'source' ? m.source_plot_name : m.dest_plot_name;
  const field = which === 'source' ? m.source_field_name : m.dest_field_name;
  const corral = which === 'source' ? m.source_corral_name : m.dest_corral_name;
  if (!cat && !plot && !corral) return null;
  const parts: string[] = [];
  if (cat) parts.push(CATEGORY_LABELS[cat] || cat);
  if (corral) {
    parts.push(`🔲 ${corral}`);
  } else if (plot) {
    parts.push(plot);
  }
  if (field) parts.push(field);
  return parts.join(' · ');
}

export default function LivestockHistoryPanel() {
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fields, setFields] = useState<FieldOption[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [category, setCategory] = useState('');
  const [movementType, setMovementType] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');

  const limit = 20;

  useEffect(() => {
    apiRequest<FiltersResponse>('/livestock/filters')
      .then(r => setFields(r.fields))
      .catch(() => {});
  }, []);

  const fetchMovements = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (fieldId) params.set('fieldId', fieldId);
      if (plotId) params.set('plotId', plotId);
      if (category) params.set('category', category);
      if (movementType) params.set('movementType', movementType);
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);
      const result = await apiRequest<PaginatedResponse>(`/livestock/movements?${params}`);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar movimientos');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, category, movementType, desde, hasta]);

  useEffect(() => {
    fetchMovements();
  }, [fetchMovements]);

  const hasFilters = !!fieldId || !!plotId || !!category || !!movementType || !!desde || !!hasta;
  const plotsForField = fieldId
    ? fields.find(f => String(f.id) === fieldId)?.plots ?? []
    : [];

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

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
        <button onClick={fetchMovements} className="ml-2 underline">Reintentar</button>
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
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Tipo</label>
          <select
            value={movementType}
            onChange={e => { setMovementType(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todos</option>
            {MOVEMENT_TYPES.map(t => (
              <option key={t} value={t}>{TYPE_LABELS[t].label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Desde</label>
          <input type="date" value={desde} onChange={e => { setDesde(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Hasta</label>
          <input type="date" value={hasta} onChange={e => { setHasta(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
        </div>
        {hasFilters && (
          <button
            onClick={() => {
              setFieldId(''); setPlotId(''); setCategory('');
              setMovementType(''); setDesde(''); setHasta(''); setPage(1);
            }}
            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline py-1.5"
          >
            Limpiar
          </button>
        )}
      </div>

      {/* Table */}
      {!data || data.items.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg">{hasFilters ? 'No hay movimientos con estos filtros' : 'No hay movimientos registrados'}</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Fecha</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Tipo</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Cantidad</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Origen</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Destino</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Detalle</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.items.map(m => {
                  const typeInfo = TYPE_LABELS[m.movement_type];
                  const TypeIcon = typeInfo?.Icon;
                  const typeLabel = typeInfo?.label ?? m.movement_type;
                  const typeColor = typeInfo?.color ?? 'bg-gray-100 text-gray-800';
                  const source = describeEndpoint(m, 'source');
                  const dest = describeEndpoint(m, 'dest');
                  return (
                    <tr key={m.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDate(m.movement_date)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${typeColor}`}>
                          {TypeIcon && <TypeIcon className="w-3.5 h-3.5" />}
                          {typeLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-800">{m.count}</td>
                      <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                        {source || <span className="text-gray-300">-</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                        {dest || <span className="text-gray-300">-</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 hidden lg:table-cell">
                        {m.avg_weight_kg != null && <span className="mr-2">~{m.avg_weight_kg} kg</span>}
                        {m.unit_price_ars != null && <span className="mr-2">${m.unit_price_ars.toLocaleString('es-AR')} ARS</span>}
                        {m.unit_price_usd != null && <span className="mr-2">US${m.unit_price_usd.toLocaleString('es-AR')}</span>}
                        {m.reason && <span className="mr-2">{m.reason}</span>}
                        {m.notes && <span className="italic text-gray-400">{m.notes}</span>}
                        {(m.linked_expense_id || m.linked_income_id) && (
                          <div className="mt-1 text-[11px] text-campo-600">
                            {m.linked_expense_id && <>🔗 Gasto #{m.linked_expense_id}</>}
                            {m.linked_income_id && <>🔗 Ingreso #{m.linked_income_id}</>}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile: show source/dest under row */}
          <div className="md:hidden px-4 py-2 text-xs text-gray-400 border-t border-gray-100">
            Ampliá la pantalla para ver origen/destino.
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <p className="text-sm text-gray-500">{data.total} movimientos en total</p>
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
    </div>
  );
}
