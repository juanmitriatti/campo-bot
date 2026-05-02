import { usePushNotifications } from '../../hooks/usePushNotifications';

export type DashboardView = 'overview' | 'expenses' | 'incomes' | 'activities' | 'observations' | 'scoutings' | 'reports' | 'harvests' | 'stock' | 'livestock' | 'documents' | 'account';

interface NavItem {
  key: DashboardView;
  label: string;
  icon: string;
  feature?: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'overview', label: 'Resumen', icon: '📊' },
  { key: 'expenses', label: 'Gastos', icon: '💸', feature: 'expenses' },
  { key: 'incomes', label: 'Ingresos', icon: '💵', feature: 'incomes' },
  { key: 'activities', label: 'Actividades', icon: '🌱', feature: 'agronomy' },
  { key: 'observations', label: 'Observaciones', icon: '👁️', feature: 'agronomy' },
  { key: 'scoutings', label: 'Monitoreos', icon: '🔍', feature: 'agronomy' },
  { key: 'reports', label: 'Reportes', icon: '📄', feature: 'agronomy' },
  { key: 'harvests', label: 'Cosechas', icon: '🌾', feature: 'agronomy' },
  { key: 'stock', label: 'Stock', icon: '📦', feature: 'stock' },
  { key: 'livestock', label: 'Hacienda', icon: '🐄', feature: 'livestock' },
  { key: 'documents', label: 'Documentos', icon: '📎', feature: 'documents' },
  { key: 'account', label: 'Mi cuenta', icon: '👤' },
];

interface SidebarProps {
  active: DashboardView;
  onChange: (view: DashboardView) => void;
  features: string[];
}

export default function Sidebar({ active, onChange, features }: SidebarProps) {
  const visibleItems = NAV_ITEMS.filter(
    item => !item.feature || features.includes(item.feature)
  );
  const { subscribed, loading, subscribe, unsubscribe } = usePushNotifications();

  return (
    <aside className="hidden md:flex flex-col w-56 bg-white border-r border-gray-200 min-h-[calc(100vh-3.5rem)]">
      <nav className="flex flex-col gap-1 p-3 pt-5">
        {visibleItems.map(item => (
          <button
            key={item.key}
            onClick={() => onChange(item.key)}
            className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
              active === item.key
                ? 'bg-campo-50 text-campo-700'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-800'
            }`}
          >
            <span className="text-base">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="mt-auto p-3 border-t border-gray-200">
        <button
          onClick={subscribed ? unsubscribe : subscribe}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100 w-full disabled:opacity-50"
          title={subscribed ? 'Desactivar notificaciones' : 'Activar notificaciones'}
        >
          <span>{subscribed ? '\uD83D\uDD14' : '\uD83D\uDD15'}</span>
          <span>{subscribed ? 'Notificaciones activas' : 'Activar notificaciones'}</span>
        </button>
      </div>
    </aside>
  );
}
