export type DashboardView = 'overview' | 'expenses' | 'incomes' | 'activities' | 'observations' | 'stock' | 'livestock';

interface NavItem {
  key: DashboardView;
  label: string;
  icon: string;
  feature?: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'overview', label: 'Resumen', icon: '📊' },
  { key: 'expenses', label: 'Gastos', icon: '💸' },
  { key: 'incomes', label: 'Ingresos', icon: '💵' },
  { key: 'activities', label: 'Actividades', icon: '🌱' },
  { key: 'observations', label: 'Observaciones', icon: '👁️' },
  { key: 'stock', label: 'Stock', icon: '📦', feature: 'stock' },
  { key: 'livestock', label: 'Hacienda', icon: '🐄', feature: 'livestock' },
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
    </aside>
  );
}
