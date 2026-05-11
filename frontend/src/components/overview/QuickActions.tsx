import { useNavigate } from 'react-router-dom';
import { Wallet, DollarSign, Sprout, BarChart3 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ACTIONS: Array<{ label: string; Icon: LucideIcon; path: string }> = [
  { label: 'Registrar gasto', Icon: Wallet, path: '/chat' },
  { label: 'Registrar ingreso', Icon: DollarSign, path: '/chat' },
  { label: 'Registrar actividad', Icon: Sprout, path: '/chat' },
  { label: 'Ver reportes', Icon: BarChart3, path: '/chat' },
];

export default function QuickActions() {
  const navigate = useNavigate();

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {ACTIONS.map(a => {
        const Icon = a.Icon;
        return (
          <button
            key={a.label}
            onClick={() => navigate(a.path)}
            className="flex items-center gap-2.5 bg-white border border-gray-200 rounded-lg px-4 py-3 hover:bg-campo-50 hover:border-campo-200 transition-colors text-left"
          >
            <Icon className="w-5 h-5 text-campo-600" />
            <span className="text-sm font-medium text-gray-700">{a.label}</span>
          </button>
        );
      })}
    </div>
  );
}
