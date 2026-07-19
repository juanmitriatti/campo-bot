import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import IncomeEditModal from './IncomeEditModal';
import IncomeCard from './cards/IncomeCard';
import { useIsMobile } from '../hooks/useIsMobile';
import { useRowHighlight } from '../hooks/useRowHighlight';
import { useSortableTable } from '../hooks/useSortableTable';
import { Trash2 } from 'lucide-react';
import TabHeader from './TabHeader';

interface Income {
  id: number;
  category: string;
  description: string | null;
  amount: number;
  currency: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  income_date: string;
  created_at: string;
  plot_name: string | null;
  field_name: string | null;
  user_name: string | null;
  edited_by_name: string | null;
  linked_from_livestock?: boolean;
}

interface PaginatedResponse {
  incomes: Income[];
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

const INCOME_CATEGORIES = [
  'soja',
  'maiz',
  'trigo',
  'girasol',
  'sorgo',
  'cebada',
  'hacienda',
  'arrendamiento',
  'otros',
];

const CATEGORY_LABELS: Record<string, string> = {
  soja: 'Soja',
  maiz: 'Maiz',
  trigo: 'Trigo',
  girasol: 'Girasol',
  sorgo: 'Sorgo',
  cebada: 'Cebada',
  hacienda: 'Hacienda',
  arrendamiento: 'Arrendamiento',
  otros: 'Otros',
};

function formatAmount(amount: number, currency: string): string {
  if (currency === 'USD') {
    return `USD ${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount)}`;
  }
  return `$${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount)}`;
}

function formatQuantity(qty: number | null, unit: string | null): string {
  if (qty == null) return '-';
  if (unit) return `${new Intl.NumberFormat('es-AR').format(qty)} ${unit}`;
  return new Intl.NumberFormat('es-AR').format(qty);
}

interface IncomeTableProps { highlightId?: number }

export default function IncomeTable({ highlightId }: IncomeTableProps = {}) {
  const isMobile = useIsMobile();
  const { active: activeHighlight, rowRef } = useRowHighlight(highlightId);
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Income | null>(null);
  const [deleting, setDeleting] = useState<Income | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [fields, setFields] = useState<FieldOption[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [category, setCategory] = useState('');
  const [descSearch, setDescSearch] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [currencyFilter, setCurrencyFilter] = useState('');

  const limit = 10;

  useEffect(() => {
    apiRequest<FiltersResponse>('/observations/filters')
      .then(r => {
        setFields(r.fields);
        if (r.fields.length === 1) setFieldId(String(r.fields[0].id));
      })
      .catch(() => {});
  }, []);

  // Auto-pick the only plot if the user has just one (within current field
  // OR overall when the field filter is "Todos").
  useEffect(() => {
    const allPlots = fields.flatMap(f => f.plots);
    const candidatePlots = fieldId
      ? fields.find(f => f.id === Number(fieldId))?.plots ?? []
      : allPlots;
    if (candidatePlots.length === 1 && !plotId) {
      setPlotId(String(candidatePlots[0].id));
    }
  }, [fields, fieldId, plotId]);

  const fetchIncomes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (fieldId) params.set('fieldId', fieldId);
      if (plotId) params.set('plotId', plotId);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (category) params.set('category', category);
      const result = await apiRequest<PaginatedResponse>(`/incomes?${params}`);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar ingresos');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, dateFrom, dateTo, category]);

  useEffect(() => {
    fetchIncomes();
  }, [fetchIncomes]);

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
    setCategory('');
    setDescSearch('');
    setAmountMin('');
    setAmountMax('');
    setCurrencyFilter('');
    setPage(1);
  };

  const handleSaved = () => {
    setEditing(null);
    fetchIncomes();
  };

  const handleDelete = async (id: number) => {
    setDeleteError(null);
    try {
      await apiRequest(`/incomes/${id}`, { method: 'DELETE' });
      setDeleting(null);
      fetchIncomes();
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'No se pudo eliminar');
    }
  };

  const hasFilters = fieldId || plotId || dateFrom || dateTo || category
    || descSearch.trim() || amountMin || amountMax || currencyFilter;

  const availablePlots = fieldId
    ? fields.find(f => f.id === Number(fieldId))?.plots ?? []
    : [];

  // Client-side filter + sort
  const filteredIncomes = (data?.incomes ?? []).filter(inc => {
    if (descSearch.trim() && !(inc.description || '').toLowerCase().includes(descSearch.trim().toLowerCase())) return false;
    if (currencyFilter && inc.currency !== currencyFilter) return false;
    const amt = Number(inc.amount);
    if (amountMin && amt < Number(amountMin)) return false;
    if (amountMax && amt > Number(amountMax)) return false;
    return true;
  });
  const { sorted: sortedIncomes, toggleSort, arrow } = useSortableTable<typeof filteredIncomes[0], 'date' | 'category' | 'description' | 'field' | 'plot' | 'quantity' | 'amount'>(filteredIncomes, {
    getValue: (row, key) => {
      switch (key) {
        case 'date': return row.income_date;
        case 'category': return row.category || '';
        case 'description': return (row.description || '').toLowerCase();
        case 'field': return (row.field_name || '').toLowerCase();
        case 'plot': return (row.plot_name || '').toLowerCase();
        case 'quantity': return row.quantity == null ? null : Number(row.quantity);
        case 'amount': return Number(row.amount);
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
        <button onClick={fetchIncomes} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  return (
    <div>
      <TabHeader
        title="Ingresos"
        description="Tus ventas y cobros."
        botHint="vendí 200 quintales de soja a 290 mil el quintal"
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
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Categoria</label>
          <select
            value={category}
            onChange={e => { setCategory(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todas</option>
            {INCOME_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Moneda</label>
          <select
            value={currencyFilter}
            onChange={e => { setCurrencyFilter(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todas</option>
            <option value="ARS">ARS</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Descripción</label>
          <input
            type="text"
            placeholder="Buscar..."
            value={descSearch}
            onChange={e => setDescSearch(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm min-w-[160px]"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Monto mín</label>
          <input
            type="number"
            placeholder="0"
            value={amountMin}
            onChange={e => setAmountMin(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm w-24"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Monto máx</label>
          <input
            type="number"
            placeholder="∞"
            value={amountMax}
            onChange={e => setAmountMax(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm w-24"
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
      {!data || data.incomes.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-300">
          <p className="text-lg">{hasFilters ? 'No hay ingresos con estos filtros' : 'No tenes ingresos todavia'}</p>
          {!hasFilters && <p className="text-sm mt-1">Los ingresos que registres por WhatsApp apareceran aca</p>}
        </div>
      ) : (
        <>
          {isMobile ? (
            <div className="space-y-3 p-4">
              {sortedIncomes.map(inc => (
                <div
                  key={inc.id}
                  ref={rowRef(inc.id)}
                  className={activeHighlight === inc.id ? 'ring-2 ring-campo-400 rounded-lg transition' : ''}
                >
                  <IncomeCard income={inc} onEdit={setEditing} onDelete={i => { setDeleting(i); setDeleteError(null); }} />
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                    <th onClick={() => toggleSort('date')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Fecha{arrow('date')}</th>
                    <th onClick={() => toggleSort('category')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Categoria{arrow('category')}</th>
                    <th onClick={() => toggleSort('description')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Descripcion{arrow('description')}</th>
                    <th onClick={() => toggleSort('field')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Campo{arrow('field')}</th>
                    <th onClick={() => toggleSort('plot')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Lote{arrow('plot')}</th>
                    <th onClick={() => toggleSort('quantity')} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden lg:table-cell cursor-pointer select-none hover:bg-gray-100">Cantidad{arrow('quantity')}</th>
                    <th onClick={() => toggleSort('amount')} className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">Monto{arrow('amount')}</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden lg:table-cell">Registrado por</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedIncomes.map(inc => (
                    <tr
                      key={inc.id}
                      ref={rowRef(inc.id) as unknown as React.Ref<HTMLTableRowElement>}
                      className={`transition-colors ${activeHighlight === inc.id ? 'bg-amber-50 dark:bg-amber-900/30' : 'hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                    >
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-300 text-sm whitespace-nowrap">
                        {formatDate(inc.income_date)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block bg-green-100 text-green-800 text-xs px-2 py-0.5 rounded">
                          {CATEGORY_LABELS[inc.category] || inc.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <p className="truncate text-gray-800 dark:text-gray-100">{inc.description || '-'}</p>
                        {inc.linked_from_livestock && (
                          <p className="text-[11px] text-campo-600 dark:text-campo-400 mt-0.5">🔗 Auto-creado por venta de hacienda</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {inc.field_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {inc.plot_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300 hidden lg:table-cell whitespace-nowrap">
                        {formatQuantity(inc.quantity, inc.unit)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-green-700 dark:text-green-400">
                        {formatAmount(inc.amount, inc.currency)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-300 text-sm hidden lg:table-cell whitespace-nowrap">
                        {inc.user_name || '-'}
                        {inc.edited_by_name && <span className="block text-gray-400">editado por {inc.edited_by_name}</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setEditing(inc)}
                            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline"
                          >
                            Editar
                          </button>
                          <button
                            onClick={() => { setDeleting(inc); setDeleteError(null); }}
                            className="text-red-400 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
                            title="Eliminar"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
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
                {data.total} ingresos en total
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
      {editing && (
        <IncomeEditModal
          income={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
      {deleting && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-sm p-6">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-2">¿Eliminar este registro?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-1">
              {deleting.income_date ? new Date(deleting.income_date).toLocaleDateString('es-AR') : ''} · {deleting.category} · {formatAmount(deleting.amount, deleting.currency)}
            </p>
            {deleting.description && <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{deleting.description}</p>}
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">Esta acción lo saca de tus listados y reportes.</p>
            {deleteError && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{deleteError}</p>}
            <div className="flex gap-3 justify-end">
              <button onClick={() => setDeleting(null)} className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
                Cancelar
              </button>
              <button
                onClick={() => void handleDelete(deleting.id)}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700"
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
