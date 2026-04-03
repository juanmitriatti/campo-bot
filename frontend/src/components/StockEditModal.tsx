import { useState } from 'react';
import { apiRequest } from '../api/client';

interface StockItem {
  id: number;
  name: string;
  category: string;
  unit: string;
  min_stock: number | null;
}

interface Props {
  item: StockItem;
  onClose: () => void;
  onSaved: () => void;
}

const STOCK_CATEGORIES = ['agroquimicos', 'fertilizantes', 'semillas', 'combustible', 'otros'];
const CATEGORY_LABELS: Record<string, string> = {
  agroquimicos: 'Agroquimicos', fertilizantes: 'Fertilizantes', semillas: 'Semillas',
  combustible: 'Combustible', otros: 'Otros',
};

export default function StockEditModal({ item, onClose, onSaved }: Props) {
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState(item.category);
  const [unit, setUnit] = useState(item.unit);
  const [minStock, setMinStock] = useState(item.min_stock != null ? String(item.min_stock) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) { setError('El nombre es requerido'); return; }
    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/stock/${item.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim(),
          category,
          unit: unit.trim(),
          min_stock: minStock ? parseFloat(minStock) : null,
        },
      });
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800">Editar producto</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Nombre</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Categoria</label>
                <select value={category} onChange={e => setCategory(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none">
                  {STOCK_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Unidad</label>
                <input type="text" value={unit} onChange={e => setUnit(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Stock minimo (alerta)</label>
              <input type="number" step="0.01" value={minStock} onChange={e => setMinStock(e.target.value)} placeholder="Sin alerta"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
            </div>
          </div>

          {error && <p className="text-red-600 text-sm mt-2">{error}</p>}

          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50">
              Cancelar
            </button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 text-sm text-white bg-campo-600 hover:bg-campo-700 rounded-md disabled:opacity-50">
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
