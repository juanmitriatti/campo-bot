import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import ActivityEditModal from './ActivityEditModal';
import ActivityCard from './cards/ActivityCard';
import { useIsMobile } from '../hooks/useIsMobile';
import { useRowHighlight } from '../hooks/useRowHighlight';
import { useSortableTable } from '../hooks/useSortableTable';

interface Activity {
  id: number;
  event_type: string;
  event_date: string;
  crop: string | null;
  product: string | null;
  product_type: string | null;
  quantity: number | null;
  unit: string | null;
  implement: string | null;
  notes: string | null;
  pregnant_count: number | null;
  open_count: number | null;
  uncertain_count: number | null;
  created_at: string;
  plot_id: number | null;
  plot_name: string | null;
  field_name: string | null;
  user_name: string | null;
  edited_by_name: string | null;
}

interface PaginatedResponse {
  activities: Activity[];
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

import { Wind, FlaskConical, Sprout, Tractor, Wheat, Droplet, Stethoscope } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ACTIVITY_TYPE_LABELS: Record<string, { label: string; Icon: LucideIcon }> = {
  spraying: { label: 'Fumigacion', Icon: Wind },
  fertilization: { label: 'Fertilizacion', Icon: FlaskConical },
  planting: { label: 'Siembra', Icon: Sprout },
  tillage: { label: 'Labranza', Icon: Tractor },
  harvest: { label: 'Cosecha', Icon: Wheat },
  irrigation: { label: 'Riego', Icon: Droplet },
  tacto: { label: 'Tacto', Icon: Stethoscope },
};

// <option> labels can't contain JSX — plain text only.
const ACTIVITY_TYPE_OPTIONS = Object.entries(ACTIVITY_TYPE_LABELS).map(([id, { label }]) => ({
  id,
  label,
}));

interface ActivityTableProps { highlightId?: number }

export default function ActivityTable({ highlightId }: ActivityTableProps = {}) {
  const isMobile = useIsMobile();
  const { active: activeHighlight, rowRef } = useRowHighlight(highlightId);
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Activity | null>(null);

  // Filter state
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [eventType, setEventType] = useState('');
  const [detailSearch, setDetailSearch] = useState('');

  const limit = 10;

  useEffect(() => {
    apiRequest<FiltersResponse>('/observations/filters')
      .then(r => setFields(r.fields))
      .catch(() => {});
  }, []);

  const fetchActivities = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (fieldId) params.set('fieldId', fieldId);
      if (plotId) params.set('plotId', plotId);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (eventType) params.set('eventType', eventType);
      const result = await apiRequest<PaginatedResponse>(`/activities?${params}`);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar actividades');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, dateFrom, dateTo, eventType]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

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
    setEventType('');
    setDetailSearch('');
    setPage(1);
  };

  const handleSaved = () => {
    setEditing(null);
    fetchActivities();
  };

  const hasFilters = fieldId || plotId || dateFrom || dateTo || eventType || detailSearch.trim();

  const availablePlots = fieldId
    ? fields.find(f => f.id === Number(fieldId))?.plots ?? []
    : [];

  // Client-side filter on detail + sort
  const filteredActivities = (data?.activities ?? []).filter(a => {
    if (!detailSearch.trim()) return true;
    const q = detailSearch.trim().toLowerCase();
    return [a.product, a.notes, a.crop, a.implement, a.field_name, a.plot_name]
      .some(v => (v || '').toLowerCase().includes(q));
  });
  const { sorted: sortedActivities, toggleSort, arrow } = useSortableTable<typeof filteredActivities[0], 'type' | 'date' | 'field' | 'plot' | 'crop' | 'product'>(filteredActivities, {
    getValue: (row, key) => {
      switch (key) {
        case 'type': return row.event_type;
        case 'date': return row.event_date;
        case 'field': return (row.field_name || '').toLowerCase();
        case 'plot': return (row.plot_name || '').toLowerCase();
        case 'crop': return (row.crop || '').toLowerCase();
        case 'product': return (row.product || '').toLowerCase();
      }
    },
    initial: { key: 'date', direction: 'desc' },
  });

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  };

  const renderTypeLabel = (type: string) => {
    const info = ACTIVITY_TYPE_LABELS[type];
    if (!info) return <>{type}</>;
    const Icon = info.Icon;
    return (
      <span className="inline-flex items-center gap-1">
        <Icon className="w-3.5 h-3.5" />
        {info.label}
      </span>
    );
  };

  const getDetail = (a: Activity) => {
    if (a.event_type === 'tacto') {
      const parts: string[] = [];
      if (a.pregnant_count != null) parts.push(`${a.pregnant_count} preñadas`);
      if (a.open_count != null && a.open_count > 0) parts.push(`${a.open_count} vacías`);
      if (a.uncertain_count != null && a.uncertain_count > 0) parts.push(`${a.uncertain_count} dudosas`);
      if (a.quantity != null && a.quantity > 0 && a.pregnant_count != null) {
        const rate = Math.round((a.pregnant_count / a.quantity) * 100);
        parts.push(`${rate}%`);
      }
      if (a.implement) parts.push(a.implement);
      return parts.join(' - ') || '-';
    }
    const parts: string[] = [];
    if (a.product) parts.push(a.product);
    if (a.quantity != null && a.unit) parts.push(`${a.quantity} ${a.unit}`);
    else if (a.quantity != null) parts.push(String(a.quantity));
    if (a.implement) parts.push(a.implement);
    if (a.notes) parts.push(a.notes);
    return parts.join(' - ') || '-';
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
        <button onClick={fetchActivities} className="ml-2 underline">Reintentar</button>
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
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Tipo</label>
          <select
            value={eventType}
            onChange={e => { setEventType(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todos</option>
            {ACTIVITY_TYPE_OPTIONS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Detalle</label>
          <input
            type="text"
            placeholder="producto, notas..."
            value={detailSearch}
            onChange={e => setDetailSearch(e.target.value)}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm min-w-[160px]"
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
      {!data || data.activities.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg">{hasFilters ? 'No hay actividades con estos filtros' : 'No tenes actividades todavia'}</p>
          {!hasFilters && <p className="text-sm mt-1">Las actividades que registres por WhatsApp apareceran aca</p>}
        </div>
      ) : (
        <>
          {isMobile ? (
            <div className="space-y-3 p-4">
              {sortedActivities.map(a => (
                <div
                  key={a.id}
                  ref={rowRef(a.id)}
                  className={activeHighlight === a.id ? 'ring-2 ring-campo-400 rounded-lg transition' : ''}
                >
                  <ActivityCard activity={a} onEdit={setEditing} />
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th onClick={() => toggleSort('type')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Tipo{arrow('type')}</th>
                    <th onClick={() => toggleSort('date')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Fecha{arrow('date')}</th>
                    <th onClick={() => toggleSort('field')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Campo{arrow('field')}</th>
                    <th onClick={() => toggleSort('plot')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Lote{arrow('plot')}</th>
                    <th onClick={() => toggleSort('crop')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Cultivo{arrow('crop')}</th>
                    <th onClick={() => toggleSort('product')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Detalle{arrow('product')}</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Registrado por</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sortedActivities.map(a => (
                    <tr
                      key={a.id}
                      ref={rowRef(a.id) as unknown as React.Ref<HTMLTableRowElement>}
                      className={`transition-colors ${activeHighlight === a.id ? 'bg-amber-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-block bg-campo-100 text-campo-800 text-xs px-2 py-0.5 rounded">
                          {renderTypeLabel(a.event_type)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {formatDate(a.event_date)}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {a.field_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {a.plot_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {a.crop || '-'}
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <p className="truncate text-gray-800">{getDetail(a)}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden lg:table-cell whitespace-nowrap">
                        {a.user_name || '-'}
                        {a.edited_by_name && <span className="block text-gray-400">editado por {a.edited_by_name}</span>}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setEditing(a)}
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
                {data.total} actividades en total
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
      {editing && (
        <ActivityEditModal
          activity={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
