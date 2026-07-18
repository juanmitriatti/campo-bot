import { Trash2 } from 'lucide-react';

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
}

const CATEGORY_LABELS: Record<string, string> = {
  combustible: 'Combustible', fertilizantes: 'Fertilizantes', semillas: 'Semillas',
  agroquimicos: 'Agroquimicos', labranzas: 'Labranzas', sueldos: 'Sueldos',
  maquinaria: 'Maquinaria', arrendamiento: 'Arrendamiento', impuestos: 'Impuestos',
  hacienda: 'Hacienda', otros: 'Otros',
};

function formatNumber(n: number): string {
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(n);
}

function formatAmount(amount: number, currency: string): string {
  if (currency === 'USD') return `USD ${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(amount)}`;
  return `$${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(amount)}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

interface Props {
  expense: Expense;
  onEdit: (e: Expense) => void;
  onDelete?: (e: Expense) => void;
}

export default function ExpenseCard({ expense, onEdit, onDelete }: Props) {
  const location = [expense.field_name, expense.plot_name].filter(Boolean).join(', ');
  const productLine = expense.product
    ? [
        expense.product,
        expense.quantity != null && expense.unit ? `${formatNumber(expense.quantity)} ${expense.unit}` : null,
        expense.unit_price != null ? `@ ${formatAmount(expense.unit_price, expense.currency)}` : null,
      ].filter(Boolean).join(' · ')
    : null;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {formatAmount(expense.amount, expense.currency)}
            </span>
            <span className="text-xs bg-campo-100 dark:bg-campo-900/30 text-campo-800 dark:text-campo-300 px-1.5 py-0.5 rounded">
              {CATEGORY_LABELS[expense.category] || expense.category}
            </span>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300 truncate">{expense.description || '-'}</p>
          {productLine && <p className="text-xs text-purple-700 mt-0.5 truncate">{productLine}</p>}
          <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-400 dark:text-gray-300">
            <span>{formatDate(expense.expense_date)}</span>
            {location && <><span>·</span><span className="truncate">{location}</span></>}
          </div>
        </div>
        <div className="flex items-center gap-2 ml-2 shrink-0">
          <button
            onClick={() => onEdit(expense)}
            className="text-campo-600 hover:text-campo-800 text-xs font-medium"
          >
            Editar
          </button>
          {onDelete && (
            <button onClick={() => onDelete(expense)} className="text-red-400 hover:text-red-600" title="Eliminar">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
