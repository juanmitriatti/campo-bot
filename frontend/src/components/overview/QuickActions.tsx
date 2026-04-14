import { useNavigate } from 'react-router-dom';

const ACTIONS = [
  { label: 'Registrar gasto', icon: '💰', path: '/chat' },
  { label: 'Registrar ingreso', icon: '💵', path: '/chat' },
  { label: 'Registrar actividad', icon: '🌱', path: '/chat' },
  { label: 'Ver reportes', icon: '📊', path: '/chat' },
];

export default function QuickActions() {
  const navigate = useNavigate();

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {ACTIONS.map(a => (
        <button
          key={a.label}
          onClick={() => navigate(a.path)}
          className="flex items-center gap-2.5 bg-white border border-gray-200 rounded-lg px-4 py-3 hover:bg-campo-50 hover:border-campo-200 transition-colors text-left"
        >
          <span className="text-lg">{a.icon}</span>
          <span className="text-sm font-medium text-gray-700">{a.label}</span>
        </button>
      ))}
    </div>
  );
}
