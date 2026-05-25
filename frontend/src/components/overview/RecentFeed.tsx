import { Wallet, DollarSign, Sprout } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const TYPE_CONFIG: Record<string, { Icon: LucideIcon; color: string }> = {
  expense: { Icon: Wallet, color: 'text-red-600' },
  income: { Icon: DollarSign, color: 'text-green-600' },
  activity: { Icon: Sprout, color: 'text-campo-700' },
};

const ACTIVITY_LABELS: Record<string, string> = {
  spraying: 'Fumigacion',
  fertilization: 'Fertilizacion',
  planting: 'Siembra',
  tillage: 'Labranza',
  harvest: 'Cosecha',
  irrigation: 'Riego',
  tacto: 'Tacto',
};

interface RecentItem {
  type: 'expense' | 'income' | 'activity';
  id: number;
  description: string | null;
  amount: number | null;
  currency: string | null;
  event_type: string | null;
  date: string;
  field_name: string | null;
  plot_name: string | null;
}

interface RecentFeedProps {
  items: RecentItem[];
  onItemClick?: (type: RecentItem['type'], id: number) => void;
  /** Optional "Ver todas →" link in the header that opens the full Activities tab. */
  onSeeAll?: () => void;
}

function formatAmount(amount: number, currency: string): string {
  if (currency === 'USD') {
    return `USD ${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(amount)}`;
  }
  return `$${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(amount)}`;
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffH = Math.floor(diffMs / 3600000);
  if (diffH < 1) return 'hace menos de 1h';
  if (diffH < 24) return `hace ${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return 'ayer';
  if (diffD < 7) return `hace ${diffD} dias`;
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

// Matches FieldMap's outer height (header 56px + map 400px desktop / 300px mobile)
const CARD_HEIGHT_DESKTOP = 456;
const CARD_HEIGHT_MOBILE = 356;

export default function RecentFeed({ items, onItemClick, onSeeAll }: RecentFeedProps) {
  const Header = (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Actividad reciente</h3>
      {onSeeAll && (
        <button
          type="button"
          onClick={onSeeAll}
          className="text-xs text-campo-700 hover:text-campo-900 dark:text-campo-400 dark:hover:text-campo-300 font-medium transition-colors"
        >
          Ver todas →
        </button>
      )}
    </div>
  );

  if (!items.length) {
    return (
      <div
        className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm p-6 flex flex-col"
        style={{ height: typeof window !== 'undefined' && window.innerWidth < 768 ? CARD_HEIGHT_MOBILE : CARD_HEIGHT_DESKTOP }}
      >
        <div className="mb-3">{Header}</div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-gray-400 dark:text-gray-300">Sin actividad reciente</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm flex flex-col overflow-hidden"
      style={{ height: typeof window !== 'undefined' && window.innerWidth < 768 ? CARD_HEIGHT_MOBILE : CARD_HEIGHT_DESKTOP }}
    >
      <div className="px-5 pt-5 pb-3 shrink-0">{Header}</div>
      <ul className="flex-1 overflow-y-auto divide-y divide-gray-50 dark:divide-gray-700">
        {items.map((item, i) => {
          const cfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.activity;
          const label = item.type === 'activity'
            ? (ACTIVITY_LABELS[item.event_type || ''] || item.event_type || 'Actividad')
            : (item.description || '-');
          const location = [item.field_name, item.plot_name].filter(Boolean).join(', ');

          const Icon = cfg.Icon;
          const clickable = !!onItemClick && item.id != null;
          // Tooltip with the full untruncated content — useful for long
          // labels like "Peón mensual diciembre" that get clipped on narrow widths.
          const tooltip = [label, location].filter(Boolean).join(' · ');
          return (
            <li
              key={`${item.type}-${item.id}-${i}`}
              onClick={clickable ? () => onItemClick!(item.type, item.id) : undefined}
              className={`flex items-center gap-3 px-5 py-3 ${clickable ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors' : ''}`}
              title={tooltip}
            >
              <Icon className={`w-5 h-5 shrink-0 ${cfg.color}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800 dark:text-gray-100 truncate">{label}</p>
                {location && <p className="text-xs text-gray-400 dark:text-gray-300 truncate">{location}</p>}
              </div>
              <div className="text-right shrink-0">
                {item.amount != null && (
                  <p className={`text-sm font-medium ${cfg.color}`}>
                    {item.type === 'expense' ? '-' : ''}{formatAmount(item.amount, item.currency || 'ARS')}
                  </p>
                )}
                <p className="text-xs text-gray-400 dark:text-gray-300">{timeAgo(item.date)}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
