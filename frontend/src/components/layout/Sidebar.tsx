import { usePushNotifications } from '../../hooks/usePushNotifications';
import { useUserFields } from '../../hooks/useUserFields';
import { useSelectedField } from '../../hooks/useSelectedField';
import FieldSelector from '../overview/FieldSelector';
import {
  LayoutDashboard, Wallet, DollarSign, Sprout, Eye, Search,
  FileText, Wheat, Package, Beef, Paperclip, User,
  Bell, BellOff, Tag, Map,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type DashboardView = 'overview' | 'fields' | 'expenses' | 'incomes' | 'activities' | 'observations' | 'scoutings' | 'reports' | 'harvests' | 'stock' | 'livestock' | 'documents' | 'categories' | 'account';

interface NavItem {
  key: DashboardView;
  label: string;
  Icon: LucideIcon;
  feature?: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'overview', label: 'Resumen', Icon: LayoutDashboard },
  { key: 'fields', label: 'Campos', Icon: Map },
  { key: 'expenses', label: 'Gastos', Icon: Wallet, feature: 'expenses' },
  { key: 'incomes', label: 'Ingresos', Icon: DollarSign, feature: 'incomes' },
  { key: 'activities', label: 'Actividades', Icon: Sprout, feature: 'agronomy' },
  { key: 'observations', label: 'Observaciones', Icon: Eye, feature: 'agronomy' },
  { key: 'scoutings', label: 'Monitoreos', Icon: Search, feature: 'agronomy' },
  { key: 'reports', label: 'Reportes', Icon: FileText, feature: 'agronomy' },
  { key: 'harvests', label: 'Cosechas', Icon: Wheat, feature: 'agronomy' },
  { key: 'stock', label: 'Stock', Icon: Package, feature: 'stock' },
  { key: 'livestock', label: 'Hacienda', Icon: Beef, feature: 'livestock' },
  { key: 'documents', label: 'Documentos', Icon: Paperclip, feature: 'documents' },
  { key: 'categories', label: 'Categorías', Icon: Tag },
  { key: 'account', label: 'Mi cuenta', Icon: User },
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
  const { fields } = useUserFields();
  const [fieldId, setFieldId] = useSelectedField();

  return (
    <aside className="hidden md:flex flex-col w-56 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 min-h-[calc(100vh-3.5rem)]">
      <FieldSelector fields={fields} value={fieldId} onChange={setFieldId} variant="sidebar" />
      <div className="border-b border-gray-100 dark:border-gray-700 mx-3" />
      <nav className="flex flex-col gap-1 p-3 pt-3">
        {visibleItems.map(item => {
          const Icon = item.Icon;
          return (
            <button
              key={item.key}
              onClick={() => onChange(item.key)}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
                active === item.key
                  ? 'bg-campo-50 text-campo-700 dark:bg-campo-900/30 dark:text-campo-400'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'
              }`}
            >
              <Icon className="w-5 h-5 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="mt-auto p-3 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={subscribed ? unsubscribe : subscribe}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 w-full disabled:opacity-50"
          title={subscribed ? 'Desactivar notificaciones' : 'Activar notificaciones'}
        >
          {subscribed ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
          <span>{subscribed ? 'Notificaciones activas' : 'Activar notificaciones'}</span>
        </button>
      </div>
    </aside>
  );
}
