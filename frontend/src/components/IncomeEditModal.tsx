import { useState } from 'react';
import { apiRequest } from '../api/client';

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
  field_name: string | null;
  plot_name: string | null;
}

interface Props {
  income: Income;
  onClose: () => void;
  onSaved: () => void;
}

function toLocalDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const INCOME_CATEGORIES = [
  'soja', 'maiz', 'trigo', 'girasol', 'sorgo', 'cebada', 'hacienda', 'arrendamiento', 'otros',
];

const CATEGORY_LABELS: Record<string, string> = {
  soja: 'Soja', maiz: 'Maiz', trigo: 'Trigo', girasol: 'Girasol',
  sorgo: 'Sorgo', cebada: 'Cebada', hacienda: 'Hacienda', arrendamiento: 'Arrendamiento', otros: 'Otros',
};

export default function IncomeEditModal({ income, onClose, onSaved }: Props) {
  const [description, setDescription] = useState(income.description || '');
  const [amount, setAmount] = useState(String(income.amount));
  const [currency, setCurrency] = useState(income.currency);
  const [category, setCategory] = useState(income.category);
  const [quantity, setQuantity] = useState(income.quantity != null ? String(income.quantity) : '');
  const [unit, setUnit] = useState(income.unit || '');
  const [unitPrice, setUnitPrice] = useState(income.unit_price != null ? String(income.unit_price) : '');
  const [incomeDate, setIncomeDate] = useState(income.income_date ? toLocalDate(income.income_date) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('El monto debe ser mayor a 0');
      return;
    }

    const parsedQty = quantity.trim() ? parseFloat(quantity) : null;
    const parsedUnitPrice = unitPrice.trim() ? parseFloat(unitPrice) : null;

    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/incomes/${income.id}`, {
        method: 'PATCH',
        body: {
          description: description.trim() || null,
          amount: parsedAmount,
          currency,
          category,
          income_date: incomeDate,
          quantity: parsedQty,
          unit: unit.trim() || null,
          unit_price: parsedUnitPrice,
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Editar ingreso</h3>
            <button onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
          </div>

          {income.field_name && <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Campo: <span className="font-medium text-gray-700 dark:text-gray-200">{income.field_name}</span></p>}
          {income.plot_name && <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">Lote: <span className="font-medium text-gray-700 dark:text-gray-200">{income.plot_name}</span></p>}

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Descripcion</label>
              <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Monto</label>
                <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Moneda</label>
                <select value={currency} onChange={e => setCurrency(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none">
                  <option value="ARS">ARS</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Categoria</label>
                <select value={category} onChange={e => setCategory(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none">
                  {INCOME_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Fecha</label>
                <input type="date" value={incomeDate} onChange={e => setIncomeDate(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Cantidad</label>
                <input type="number" step="0.01" value={quantity} onChange={e => setQuantity(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: 30" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Unidad</label>
                <input type="text" value={unit} onChange={e => setUnit(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: tn" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Precio unitario</label>
                <input type="number" step="0.01" value={unitPrice} onChange={e => setUnitPrice(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: 250000" />
              </div>
            </div>
          </div>

          {error && <p className="text-red-600 text-sm mt-2">{error}</p>}

          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
              Cancelar
            </button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 text-sm text-white bg-campo-600 hover:bg-campo-700 rounded-md disabled:opacity-50 transition-colors">
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
