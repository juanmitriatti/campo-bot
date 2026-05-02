import type { DashboardView } from './Sidebar';

interface BottomNavItem {
  key: DashboardView;
  label: string;
  icon: string;
  feature?: string;
}

const ITEMS: BottomNavItem[] = [
  { key: 'overview', label: 'Resumen', icon: '📊' },
  { key: 'expenses', label: 'Gastos', icon: '💸', feature: 'expenses' },
  { key: 'incomes', label: 'Ingresos', icon: '💵', feature: 'incomes' },
  { key: 'activities', label: 'Actividades', icon: '🌱', feature: 'agronomy' },
  { key: 'observations', label: 'Obs.', icon: '👁️', feature: 'agronomy' },
  { key: 'scoutings', label: 'Monitor.', icon: '🔍', feature: 'agronomy' },
  { key: 'reports', label: 'Reportes', icon: '📄', feature: 'agronomy' },
  { key: 'harvests', label: 'Cosechas', icon: '🌾', feature: 'agronomy' },
  { key: 'documents', label: 'Docs', icon: '📎', feature: 'documents' },
  { key: 'account', label: 'Cuenta', icon: '👤' },
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
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
      <div className="flex justify-around items-center h-14">
        {visibleItems.map(item => (
          <button
            key={item.key}
            onClick={() => onChange(item.key)}
            className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors ${
              active === item.key
                ? 'text-campo-600'
                : 'text-gray-400'
            }`}
          >
            <span className="text-lg">{item.icon}</span>
            <span className="text-[10px] font-medium leading-tight">{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
