import {
  LayoutDashboard, Wallet, DollarSign, Sprout, Eye, Search,
  FileText, Wheat, Paperclip, User, Tag, Map,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DashboardView } from './Sidebar';

interface BottomNavItem {
  key: DashboardView;
  label: string;
  Icon: LucideIcon;
  feature?: string;
}

const ITEMS: BottomNavItem[] = [
  { key: 'overview', label: 'Resumen', Icon: LayoutDashboard },
  { key: 'fields', label: 'Campos', Icon: Map },
  { key: 'expenses', label: 'Gastos', Icon: Wallet, feature: 'expenses' },
  { key: 'incomes', label: 'Ingresos', Icon: DollarSign, feature: 'incomes' },
  { key: 'activities', label: 'Actividades', Icon: Sprout, feature: 'agronomy' },
  { key: 'observations', label: 'Obs.', Icon: Eye, feature: 'agronomy' },
  { key: 'scoutings', label: 'Monitor.', Icon: Search, feature: 'agronomy' },
  { key: 'reports', label: 'Reportes', Icon: FileText, feature: 'agronomy' },
  { key: 'harvests', label: 'Cosechas', Icon: Wheat, feature: 'agronomy' },
  { key: 'documents', label: 'Docs', Icon: Paperclip, feature: 'documents' },
  { key: 'categories', label: 'Categ.', Icon: Tag },
  { key: 'account', label: 'Cuenta', Icon: User },
];

interface BottomNavProps {
  active: DashboardView;
  onChange: (view: DashboardView) => void;
  features: string[];
}

export default function BottomNav({ active, onChange, features }: BottomNavProps) {
  const visibleItems = ITEMS.filter(
    item => !item.feature || features.includes(item.feature)
  );

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 shadow-lg z-50">
      <div className="flex justify-around items-center h-14">
        {visibleItems.map(item => {
          const Icon = item.Icon;
          return (
            <button
              key={item.key}
              onClick={() => onChange(item.key)}
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors ${
                active === item.key
                  ? 'text-campo-600'
                  : 'text-gray-400 dark:text-gray-300'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium leading-tight">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
