import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import StockMovementHistory from './StockMovementHistory';
import StockEditModal from './StockEditModal';

interface StockItem {
  id: number;
  name: string;
  category: string;
  current_quantity: number;
  unit: string;
  min_stock: number | null;
  warehouse_name: string;
  field_name: string;
  field_id: number;
  updated_at: string;
}

interface PaginatedResponse {
  items: StockItem[];
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
}

interface WarehouseOption {
  id: number;
  name: string;
  fieldId: number;
  fieldName: string | null;
}

interface WarehousesResponse {
  warehouses: WarehouseOption[];
}

const STOCK_CATEGORIES: Record<string, string> = {
  agroquimicos: 'Agroquímicos',
  fertilizantes: 'Fertilizantes',
  semillas: 'Semillas',
  granos: 'Granos',
  combustible: 'Combustible',
  otros: 'Otros',
};

interface StockTableProps {
  initialLowStockOnly?: boolean;
}

export default function StockTable({ initialLowStockOnly = false }: StockTableProps = {}) {
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewingMovements, setViewingMovements] = useState<StockItem | null>(null);
  const [editing, setEditing] = useState<StockItem | null>(null);

  const [fields, setFields] = useState<FieldOption[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [category, setCategory] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(initialLowStockOnly);
  const [search, setSearch] = useState('');

  const limit = 15;

  useEffect(() => {
    apiRequest<FiltersResponse>('/observations/filters')
      .then(r => {
        setFields(r.fields);
        if (r.fields.length === 1) setFieldId(String(r.fields[0].id));
      })
      .catch(() => {});
    apiRequest<WarehousesResponse>('/warehouses')
      .then(r => {
        setWarehouses(r.warehouses);
        if (r.warehouses.length === 1) setWarehouseId(String(r.warehouses[0].id));
      })
      .catch(() => {});
  }, []);

  // Auto-clear depósito when field changes (depósito belongs to field)
  useEffect(() => {
    if (warehouseId && fieldId) {
      const w = warehouses.find(w => String(w.id) === warehouseId);
      if (w && String(w.fieldId) !== fieldId) setWarehouseId('');
    }
  }, [fieldId, warehouseId, warehouses]);

  const availableWarehouses = fieldId
    ? warehouses.filter(w => String(w.fieldId) === fieldId)
    : warehouses;

  const fetchStock = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (fieldId) params.set('fieldId', fieldId);
      if (warehouseId) params.set('warehouseId', warehouseId);
      if (category) params.set('category', category);
      const result = await apiRequest<PaginatedResponse>(`/stock?${params}`);
      // Client-side filters (cheap — pageItems is already small):
      let items = result.items;
      if (lowStockOnly) {
        items = items.filter(i => i.min_stock != null && Number(i.current_quantity) <= Number(i.min_stock));
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        items = items.filter(i => i.name.toLowerCase().includes(q));
      }
      setData({ ...result, items });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar stock');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, warehouseId, category, lowStockOnly, search]);

  useEffect(() => {
    fetchStock();
  }, [fetchStock]);

  const handleSaved = () => {
    setEditing(null);
    fetchStock();
  };

  const hasFilters = !!fieldId || !!warehouseId || !!category || lowStockOnly || !!search.trim();

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
        <button onClick={fetchStock} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 text-sm">
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Campo</label>
          <select
            value={fieldId}
            onChange={e => { setFieldId(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          >
            {fields.length !== 1 && <option value="">Todos</option>}
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Depósito</label>
          <select
            value={warehouseId}
            onChange={e => { setWarehouseId(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          >
            {availableWarehouses.length !== 1 && <option value="">Todos</option>}
            {availableWarehouses.map(w => (
              <option key={w.id} value={w.id}>
                {fieldId ? w.name : `${w.name} (${w.fieldName})`}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Categoría</label>
          <select
            value={category}
            onChange={e => { setCategory(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todas</option>
            {Object.entries(STOCK_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Buscar</label>
          <input
            type="text"
            placeholder="Nombre del producto"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm min-w-[180px]"
          />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-200 cursor-pointer pb-1.5">
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={e => { setLowStockOnly(e.target.checked); setPage(1); }}
            className="w-4 h-4 text-campo-600 rounded border-gray-300 focus:ring-campo-500"
          />
          <span className="text-amber-700 font-medium">Solo bajo stock</span>
        </label>
        {hasFilters && (
          <button
            onClick={() => {
              setFieldId(fields.length === 1 ? String(fields[0].id) : '');
              setWarehouseId(warehouses.length === 1 ? String(warehouses[0].id) : '');
              setCategory('');
              setLowStockOnly(false);
              setSearch('');
              setPage(1);
            }}
            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline py-1.5"
          >
            Limpiar
          </button>
        )}
      </div>

      {/* Table */}
      {!data || data.items.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-300">
          <p className="text-lg">{hasFilters ? 'No hay stock con estos filtros' : 'No tenes stock registrado'}</p>
          {!hasFilters && <p className="text-sm mt-1">Carga insumos por WhatsApp o Telegram con "cargue X de Y"</p>}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">Producto</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden md:table-cell">Categoria</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">Cantidad</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden sm:table-cell">Unidad</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden md:table-cell">Deposito</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300 hidden lg:table-cell">Campo</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Min</th>
                  <th className="px-4 py-3 w-32" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {data.items.map(item => {
                  const isLow = item.min_stock != null && item.current_quantity <= item.min_stock;
                  return (
                    <tr key={item.id} className={`hover:bg-gray-50 transition-colors ${isLow ? 'bg-red-50' : ''}`}>
                      <td className="px-4 py-3">
                        <p className="text-gray-800 dark:text-gray-100 font-medium">{item.name}</p>
                        <p className="text-xs text-gray-400 md:hidden">
                          {STOCK_CATEGORIES[item.category] || item.category} · {item.warehouse_name} · {item.field_name}
                        </p>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="inline-block bg-campo-100 text-campo-800 text-xs px-2 py-0.5 rounded">
                          {STOCK_CATEGORIES[item.category] || item.category}
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-right font-medium ${isLow ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>
                        {item.current_quantity}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300 hidden sm:table-cell">{item.unit}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300 hidden md:table-cell">{item.warehouse_name}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300 hidden lg:table-cell">{item.field_name}</td>
                      <td className="px-4 py-3 text-center hidden md:table-cell">
                        {item.min_stock != null ? (
                          <span className={`text-xs ${isLow ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                            {item.min_stock}
                          </span>
                        ) : <span className="text-gray-300">-</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => setViewingMovements(item)}
                            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline"
                          >
                            Movimientos
                          </button>
                          <button
                            onClick={() => setEditing(item)}
                            className="text-campo-600 hover:text-campo-800 text-xs font-medium hover:underline"
                          >
                            Editar
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
              <p className="text-sm text-gray-500 dark:text-gray-300">{data.total} productos en total</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Anterior
                </button>
                <span className="text-sm text-gray-600 dark:text-gray-300">{page} / {data.totalPages}</span>
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
        <StockMovementHistory
          item={viewingMovements}
          onClose={() => setViewingMovements(null)}
        />
      )}
      {editing && (
        <StockEditModal
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
