import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { useRowHighlight } from '../hooks/useRowHighlight';
import { useSortableTable } from '../hooks/useSortableTable';
import ExpenseEditModal from './ExpenseEditModal';
import ExpenseCard from './cards/ExpenseCard';
import { useIsMobile } from '../hooks/useIsMobile';

interface Expense {
  id: number;
  category: string;
  description: string | null;
  amount: number;
  currency: string;
  expense_date: string;
  created_at: string;
  plot_name: string | null;
  field_name: string | null;
  user_name: string | null;
  edited_by_name: string | null;
  expense_type: string | null;
  product: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  linked_from_livestock?: boolean;
  linked_from_document?: boolean;
}

interface PaginatedResponse {
  expenses: Expense[];
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

const EXPENSE_CATEGORIES = [
  'combustible',
  'fertilizantes',
  'semillas',
  'agroquimicos',
  'labranzas',
  'sueldos',
  'maquinaria',
  'arrendamiento',
  'impuestos',
  'otros',
];

const CATEGORY_LABELS: Record<string, string> = {
  combustible: 'Combustible',
  fertilizantes: 'Fertilizantes',
  semillas: 'Semillas',
  agroquimicos: 'Agroquimicos',
  labranzas: 'Labranzas',
  sueldos: 'Sueldos',
  maquinaria: 'Maquinaria',
  arrendamiento: 'Arrendamiento',
  impuestos: 'Impuestos',
  otros: 'Otros',
};

const EXPENSE_TYPE_LABELS: Record<string, string> = {
  insumo: 'Insumo',
  varios: 'Varios',
};

function formatAmount(amount: number, currency: string): string {
  if (currency === 'USD') {
    return `USD ${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount)}`;
  }
  return `$${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount)}`;
}

interface ExpenseTableProps { highlightId?: number }

export default function ExpenseTable({ highlightId }: ExpenseTableProps = {}) {
  const isMobile = useIsMobile();
  const { active: activeHighlight, rowRef } = useRowHighlight(highlightId);
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Expense | null>(null);

  const [fields, setFields] = useState<FieldOption[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [category, setCategory] = useState('');
  const [expenseType, setExpenseType] = useState('');
  const [descSearch, setDescSearch] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [currencyFilter, setCurrencyFilter] = useState('');

  const limit = 10;

  useEffect(() => {
    apiRequest<FiltersResponse>('/observations/filters')
      .then(r => {
        setFields(r.fields);
        // If user has a single field, auto-pick it (no point in "Todos")
        if (r.fields.length === 1) setFieldId(String(r.fields[0].id));
      })
      .catch(() => {});
  }, []);

  // Auto-pick the only plot when there's just one (within the active field
  // OR across all fields if the field filter is "Todos").
  useEffect(() => {
    const allPlots = fields.flatMap(f => f.plots);
    const candidatePlots = fieldId
      ? fields.find(f => f.id === Number(fieldId))?.plots ?? []
      : allPlots;
    if (candidatePlots.length === 1 && !plotId) {
      setPlotId(String(candidatePlots[0].id));
    }
  }, [fields, fieldId, plotId]);

  const fetchExpenses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (fieldId) params.set('fieldId', fieldId);
      if (plotId) params.set('plotId', plotId);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (category) params.set('category', category);
      if (expenseType) params.set('expenseType', expenseType);
      const result = await apiRequest<PaginatedResponse>(`/expenses?${params}`);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar gastos');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, dateFrom, dateTo, category, expenseType]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

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
    setExpenseType('');
    setDescSearch('');
    setAmountMin('');
    setAmountMax('');
    setCurrencyFilter('');
    setPage(1);
  };

  // Client-side filters + sort applied on top of the paginated server response.
  // Search/amount/currency stay client-side so the user gets instant feedback
  // without hitting the API on every keystroke; the trade-off is that they
  // only filter within the current page.
  const filteredExpenses = (data?.expenses ?? []).filter(exp => {
    if (descSearch.trim() && !(exp.description || '').toLowerCase().includes(descSearch.trim().toLowerCase())) return false;
    if (currencyFilter && exp.currency !== currencyFilter) return false;
    const amt = Number(exp.amount);
    if (amountMin && amt < Number(amountMin)) return false;
    if (amountMax && amt > Number(amountMax)) return false;
    return true;
  });
  const { sorted: sortedExpenses, toggleSort, arrow } = useSortableTable<typeof filteredExpenses[0], 'date' | 'category' | 'description' | 'product' | 'field' | 'plot' | 'amount'>(filteredExpenses, {
    getValue: (row, key) => {
      switch (key) {
        case 'date': return row.expense_date;
        case 'category': return row.category || '';
        case 'description': return (row.description || '').toLowerCase();
        case 'product': return (row.product || '').toLowerCase();
        case 'field': return (row.field_name || '').toLowerCase();
        case 'plot': return (row.plot_name || '').toLowerCase();
        case 'amount': return Number(row.amount);
      }
    },
    initial: { key: 'date', direction: 'desc' },
  });

  const handleSaved = () => {
    setEditing(null);
    fetchExpenses();
  };

  const hasFilters = fieldId || plotId || dateFrom || dateTo || category || expenseType
    || descSearch.trim() || amountMin || amountMax || currencyFilter;

  const availablePlots = fieldId
    ? fields.find(f => f.id === Number(fieldId))?.plots ?? []
    : [];

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
      <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700 text-sm">
        {error}
        <button onClick={fetchExpenses} className="ml-2 underline">Reintentar</button>
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
            {fields.length !== 1 && <option value="">Todos</option>}
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
            {availablePlots.length !== 1 && <option value="">Todos</option>}
            {availablePlots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Categoria</label>
          <select
            value={category}
            onChange={e => { setCategory(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todas</option>
            {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Tipo</label>
          <select
            value={expenseType}
            onChange={e => { setExpenseType(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todos</option>
            <option value="insumo">Insumo</option>
            <option value="varios">Varios</option>
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Moneda</label>
          <select
            value={currencyFilter}
            onChange={e => { setCurrencyFilter(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todas</option>
            <option value="ARS">ARS</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Descripción</label>
          <input
            type="text"
            placeholder="Buscar..."
            value={descSearch}
            onChange={e => setDescSearch(e.target.value)}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm min-w-[160px]"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Monto mín</label>
          <input
            type="number"
            placeholder="0"
            value={amountMin}
            onChange={e => setAmountMin(e.target.value)}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm w-24"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 mb-1">Monto máx</label>
          <input
            type="number"
            placeholder="∞"
            value={amountMax}
            onChange={e => setAmountMax(e.target.value)}
            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm w-24"
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
      {!data || data.expenses.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg">{hasFilters ? 'No hay gastos con estos filtros' : 'No tenes gastos todavia'}</p>
          {!hasFilters && <p className="text-sm mt-1">Los gastos que registres por WhatsApp apareceran aca</p>}
        </div>
      ) : (
        <>
          {isMobile ? (
            <div className="space-y-3 p-4">
              {sortedExpenses.map(exp => (
                <div
                  key={exp.id}
                  ref={rowRef(exp.id)}
                  className={activeHighlight === exp.id ? 'ring-2 ring-campo-400 rounded-lg transition' : ''}
                >
                  <ExpenseCard expense={exp} onEdit={setEditing} />
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th onClick={() => toggleSort('date')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Fecha{arrow('date')}</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Tipo</th>
                    <th onClick={() => toggleSort('category')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Categoria{arrow('category')}</th>
                    <th onClick={() => toggleSort('description')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Descripcion{arrow('description')}</th>
                    <th onClick={() => toggleSort('product')} className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell cursor-pointer select-none hover:bg-gray-100">Producto{arrow('product')}</th>
                    <th onClick={() => toggleSort('field')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Campo{arrow('field')}</th>
                    <th onClick={() => toggleSort('plot')} className="text-left px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Lote{arrow('plot')}</th>
                    <th onClick={() => toggleSort('amount')} className="text-right px-4 py-3 font-medium text-gray-600 cursor-pointer select-none hover:bg-gray-100">Monto{arrow('amount')}</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Registrado por</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sortedExpenses.map(exp => (
                    <tr
                      key={exp.id}
                      ref={rowRef(exp.id) as unknown as React.Ref<HTMLTableRowElement>}
                      className={`transition-colors ${activeHighlight === exp.id ? 'bg-amber-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {formatDate(exp.expense_date)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block text-xs px-2 py-0.5 rounded ${
                          exp.expense_type === 'insumo'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-gray-100 text-gray-700'
                        }`}>
                          {exp.expense_type === 'insumo' ? 'Insumo' : 'Varios'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block bg-campo-100 text-campo-800 text-xs px-2 py-0.5 rounded">
                          {CATEGORY_LABELS[exp.category] || exp.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <p className="truncate text-gray-800">{exp.description || '-'}</p>
                        {(exp.linked_from_livestock || exp.linked_from_document) && (
                          <p className="text-[11px] text-campo-600 mt-0.5">
                            {exp.linked_from_livestock && '🔗 Auto-creado por hacienda'}
                            {exp.linked_from_document && (exp.linked_from_livestock ? ' · ' : '') + '📎 Vinculado a documento'}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 hidden lg:table-cell">
                        {exp.product ? (
                          <span>
                            {exp.product}
                            {exp.quantity && exp.unit && <span className="text-xs text-gray-400 ml-1">({exp.quantity} {exp.unit})</span>}
                          </span>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {exp.field_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {exp.plot_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-gray-800">
                        {formatAmount(exp.amount, exp.currency)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden lg:table-cell whitespace-nowrap">
                        {exp.user_name || '-'}
                        {exp.edited_by_name && <span className="block text-gray-400">editado por {exp.edited_by_name}</span>}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setEditing(exp)}
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
                {data.total} gastos en total
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
        <ExpenseEditModal
          expense={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
