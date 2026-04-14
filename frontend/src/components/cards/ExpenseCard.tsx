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
}

const CATEGORY_LABELS: Record<string, string> = {
  combustible: 'Combustible', fertilizantes: 'Fertilizantes', semillas: 'Semillas',
  agroquimicos: 'Agroquimicos', labranzas: 'Labranzas', sueldos: 'Sueldos',
  maquinaria: 'Maquinaria', arrendamiento: 'Arrendamiento', impuestos: 'Impuestos', otros: 'Otros',
};

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
}

export default function ExpenseCard({ expense, onEdit }: Props) {
  const location = [expense.field_name, expense.plot_name].filter(Boolean).join(', ');

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-gray-900">
              {formatAmount(expense.amount, expense.currency)}
            </span>
            <span className="text-xs bg-campo-100 text-campo-800 px-1.5 py-0.5 rounded">
              {CATEGORY_LABELS[expense.category] || expense.category}
            </span>
          </div>
          <p className="text-sm text-gray-600 truncate">{expense.description || '-'}</p>
          <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-400">
            <span>{formatDate(expense.expense_date)}</span>
            {location && <><span>·</span><span className="truncate">{location}</span></>}
          </div>
        </div>
        <button
          onClick={() => onEdit(expense)}
          className="text-campo-600 hover:text-campo-800 text-xs font-medium ml-2 shrink-0"
        >
          Editar
        </button>
      </div>
    </div>
  );
}
