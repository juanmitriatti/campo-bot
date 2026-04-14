import type { DashboardView } from './Sidebar';

interface BottomNavItem {
  key: DashboardView;
  label: string;
  icon: string;
}

const ITEMS: BottomNavItem[] = [
  { key: 'overview', label: 'Resumen', icon: '📊' },
  { key: 'expenses', label: 'Gastos', icon: '💸' },
  { key: 'incomes', label: 'Ingresos', icon: '💵' },
  { key: 'activities', label: 'Actividades', icon: '🌱' },
  { key: 'observations', label: 'Obs.', icon: '👁️' },
];

interface BottomNavProps {
  active: DashboardView;
  onChange: (view: DashboardView) => void;
}

export default function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
      <div className="flex justify-around items-center h-14">
        {ITEMS.map(item => (
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
