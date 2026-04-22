import { useState } from 'react';
import { apiRequest } from '../api/client';

interface Expense {
  id: number;
  category: string;
  description: string | null;
  amount: number;
  currency: string;
  expense_date: string;
  field_name: string | null;
  plot_name: string | null;
  expense_type: string | null;
  product: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
}

interface Props {
  expense: Expense;
  onClose: () => void;
  onSaved: () => void;
}

function toLocalDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const EXPENSE_CATEGORIES = [
  'combustible', 'fertilizantes', 'semillas', 'agroquimicos',
  'labranzas', 'sueldos', 'maquinaria', 'arrendamiento', 'impuestos', 'hacienda', 'otros',
];

const CATEGORY_LABELS: Record<string, string> = {
  combustible: 'Combustible', fertilizantes: 'Fertilizantes', semillas: 'Semillas',
  agroquimicos: 'Agroquimicos', labranzas: 'Labranzas', sueldos: 'Sueldos', maquinaria: 'Maquinaria',
  arrendamiento: 'Arrendamiento', impuestos: 'Impuestos', hacienda: 'Hacienda', otros: 'Otros',
};

const INSUMO_CATEGORIES = new Set(['agroquimicos', 'fertilizantes', 'semillas', 'combustible']);

export default function ExpenseEditModal({ expense, onClose, onSaved }: Props) {
  const [description, setDescription] = useState(expense.description || '');
  const [amount, setAmount] = useState(String(expense.amount));
  const [currency, setCurrency] = useState(expense.currency);
  const [category, setCategory] = useState(expense.category);
  const [expenseDate, setExpenseDate] = useState(expense.expense_date ? toLocalDate(expense.expense_date) : '');
  const [expenseTypeVal, setExpenseTypeVal] = useState(expense.expense_type || 'varios');
  const [product, setProduct] = useState(expense.product || '');
  const [quantity, setQuantity] = useState(expense.quantity != null ? String(expense.quantity) : '');
  const [unit, setUnit] = useState(expense.unit || '');
  const [unitPrice, setUnitPrice] = useState(expense.unit_price != null ? String(expense.unit_price) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isInsumo = expenseTypeVal === 'insumo';

  const handleSave = async () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('El monto debe ser mayor a 0');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/expenses/${expense.id}`, {
        method: 'PATCH',
        body: {
          description: description.trim() || null,
          amount: parsedAmount,
          currency,
          category,
          expense_date: expenseDate,
          expense_type: expenseTypeVal,
          product: isInsumo ? (product.trim() || null) : null,
          quantity: isInsumo && quantity ? parseFloat(quantity) : null,
          unit: isInsumo ? (unit.trim() || null) : null,
          unit_price: isInsumo && unitPrice ? parseFloat(unitPrice) : null,
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
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800">Editar gasto</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
          </div>

          {expense.field_name && <p className="text-sm text-gray-500 mb-1">Campo: <span className="font-medium text-gray-700">{expense.field_name}</span></p>}
          {expense.plot_name && <p className="text-sm text-gray-500 mb-3">Lote: <span className="font-medium text-gray-700">{expense.plot_name}</span></p>}

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Descripcion</label>
              <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Monto</label>
                <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Moneda</label>
                <select value={currency} onChange={e => setCurrency(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none">
                  <option value="ARS">ARS</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Tipo</label>
                <select value={expenseTypeVal} onChange={e => {
                  setExpenseTypeVal(e.target.value);
                  if (e.target.value === 'varios') { setProduct(''); setQuantity(''); setUnit(''); setUnitPrice(''); }
                }}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none">
                  <option value="varios">Varios</option>
                  <option value="insumo">Insumo</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Categoria</label>
                <select value={category} onChange={e => {
                  setCategory(e.target.value);
                  if (INSUMO_CATEGORIES.has(e.target.value)) setExpenseTypeVal('insumo');
                }}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none">
                  {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Fecha</label>
                <input type="date" value={expenseDate} onChange={e => setExpenseDate(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
              </div>
            </div>
            {isInsumo && (
              <div className="grid grid-cols-2 gap-3 p-3 bg-purple-50 rounded-md border border-purple-200">
                <div>
                  <label className="block text-xs text-purple-600 mb-1">Producto</label>
                  <input type="text" value={product} onChange={e => setProduct(e.target.value)} placeholder="Ej: Roundup"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-purple-600 mb-1">Unidad</label>
                  <input type="text" value={unit} onChange={e => setUnit(e.target.value)} placeholder="Ej: lt, kg, bolsas"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-purple-600 mb-1">Cantidad</label>
                  <input type="number" step="0.01" value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="Ej: 20"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-purple-600 mb-1">Precio unitario</label>
                  <input type="number" step="0.01" value={unitPrice} onChange={e => setUnitPrice(e.target.value)} placeholder="Ej: 8000"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
                </div>
              </div>
            )}
          </div>

          {error && <p className="text-red-600 text-sm mt-2">{error}</p>}

          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
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
