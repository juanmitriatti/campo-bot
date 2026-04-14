const TYPE_CONFIG: Record<string, { icon: string; color: string }> = {
  expense: { icon: '💰', color: 'text-red-600' },
  income: { icon: '💵', color: 'text-green-600' },
  activity: { icon: '🌱', color: 'text-campo-700' },
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
  description: string | null;
  amount: number | null;
  currency: string | null;
  event_type: string | null;
  date: string;
  field_name: string | null;
  plot_name: string | null;
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

export default function RecentFeed({ items }: { items: RecentItem[] }) {
  if (!items.length) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Actividad reciente</h3>
        <p className="text-sm text-gray-400">Sin actividad reciente</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
      <div className="px-5 pt-5 pb-3">
        <h3 className="text-sm font-semibold text-gray-700">Actividad reciente</h3>
      </div>
      <ul className="divide-y divide-gray-50">
        {items.map((item, i) => {
          const cfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.activity;
          const label = item.type === 'activity'
            ? (ACTIVITY_LABELS[item.event_type || ''] || item.event_type || 'Actividad')
            : (item.description || '-');
          const location = [item.field_name, item.plot_name].filter(Boolean).join(', ');

          return (
            <li key={i} className="flex items-center gap-3 px-5 py-3">
              <span className="text-base">{cfg.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800 truncate">{label}</p>
                {location && <p className="text-xs text-gray-400 truncate">{location}</p>}
              </div>
              <div className="text-right shrink-0">
                {item.amount != null && (
                  <p className={`text-sm font-medium ${cfg.color}`}>
                    {item.type === 'expense' ? '-' : ''}{formatAmount(item.amount, item.currency || 'ARS')}
                  </p>
                )}
                <p className="text-xs text-gray-400">{timeAgo(item.date)}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
