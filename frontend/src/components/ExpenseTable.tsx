import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import ExpenseEditModal from './ExpenseEditModal';

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
  sueldos: 'Sueldos',
  maquinaria: 'Maquinaria',
  arrendamiento: 'Arrendamiento',
  impuestos: 'Impuestos',
  otros: 'Otros',
};

function formatAmount(amount: number, currency: string): string {
  if (currency === 'USD') {
    return `USD ${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount)}`;
  }
  return `$${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount)}`;
}

export default function ExpenseTable() {
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

  const limit = 10;

  useEffect(() => {
    apiRequest<FiltersResponse>('/observations/filters')
      .then(r => setFields(r.fields))
      .catch(() => {});
  }, []);

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
      const result = await apiRequest<PaginatedResponse>(`/expenses?${params}`);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar gastos');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, dateFrom, dateTo, category]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

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
    setCategory('');
    setPage(1);
  };

  const handleSaved = () => {
    setEditing(null);
    fetchExpenses();
  };

  const hasFilters = fieldId || plotId || dateFrom || dateTo || category;

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
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline py-1.5"
          >
            Limpiar
          </button>
        )}
      </div>

      {/* Table */}
      {!data || data.expenses.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg">{hasFilters ? 'No hay gastos con estos filtros' : 'No tenes gastos todavia'}</p>
          {!hasFilters && <p className="text-sm mt-1">Los gastos que registres por WhatsApp apareceran aca</p>}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Fecha</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Categoria</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Descripcion</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Campo</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Lote</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Monto</th>
                  <th className="px-4 py-3 w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.expenses.map(exp => (
                  <tr key={exp.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {formatDate(exp.expense_date)}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="inline-block bg-campo-100 text-campo-800 text-xs px-2 py-0.5 rounded">
                        {CATEGORY_LABELS[exp.category] || exp.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <p className="truncate text-gray-800">{exp.description || '-'}</p>
                      <p className="text-xs text-gray-400 md:hidden">
                        {CATEGORY_LABELS[exp.category] || exp.category}
                        {exp.field_name && ` · ${exp.field_name}`}
                        {exp.plot_name && ` · ${exp.plot_name}`}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                      {exp.field_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden sm:table-cell">
                      {exp.plot_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-gray-800">
                      {formatAmount(exp.amount, exp.currency)}
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
