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
}

const CATEGORY_LABELS: Record<string, string> = {
  soja: 'Soja', maiz: 'Maiz', trigo: 'Trigo', girasol: 'Girasol',
  sorgo: 'Sorgo', cebada: 'Cebada', hacienda: 'Hacienda',
  arrendamiento: 'Arrendamiento', otros: 'Otros',
};

function formatAmount(amount: number, currency: string): string {
  if (currency === 'USD') return `USD ${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(amount)}`;
  return `$${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(amount)}`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(n);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

interface Props {
  income: Income;
  onEdit: (i: Income) => void;
}

export default function IncomeCard({ income, onEdit }: Props) {
  const location = [income.field_name, income.plot_name].filter(Boolean).join(', ');
  const quantityLine = income.quantity != null && income.unit
    ? [
        `${formatNumber(income.quantity)} ${income.unit}`,
        income.unit_price != null ? `@ ${formatAmount(income.unit_price, income.currency)}` : null,
      ].filter(Boolean).join(' · ')
    : null;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-green-700 dark:text-green-400">
              {formatAmount(income.amount, income.currency)}
            </span>
            <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 px-1.5 py-0.5 rounded">
              {CATEGORY_LABELS[income.category] || income.category}
            </span>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300 truncate">{income.description || '-'}</p>
          {quantityLine && <p className="text-xs text-emerald-700 mt-0.5 truncate">{quantityLine}</p>}
          <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-400 dark:text-gray-500">
            <span>{formatDate(income.income_date)}</span>
            {location && <><span>·</span><span className="truncate">{location}</span></>}
          </div>
        </div>
        <button
          onClick={() => onEdit(income)}
          className="text-campo-600 hover:text-campo-800 text-xs font-medium ml-2 shrink-0"
        >
          Editar
        </button>
      </div>
    </div>
  );
}
