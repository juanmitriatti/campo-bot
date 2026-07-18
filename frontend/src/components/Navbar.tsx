import { useNavigate, useLocation } from 'react-router-dom';
import { CircleUser } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface NavbarProps {
  onUserClick?: () => void;
}

export default function Navbar({ onUserClick }: NavbarProps) {
  const { user, plan, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleUserClick = () => {
    if (onUserClick) {
      onUserClick();
    } else {
      navigate('/dashboard');
    }
  };

  if (!user) return null;

  const isAdmin = user.role === 'admin';
  const isChat = location.pathname === '/chat';

  return (
    <nav className="bg-campo-700 text-white shadow-md sticky top-0 z-40">
      <div className="px-4 md:px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className="text-xl font-bold tracking-tight cursor-pointer"
            onClick={() => navigate('/dashboard')}
          >
            Campo Bot
          </span>
          {plan && (
            <span className="text-xs bg-campo-500 px-2 py-0.5 rounded-full font-medium hidden sm:inline-block">
              {plan.display_name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <button
              onClick={() => navigate(isChat ? '/dashboard' : '/chat')}
              className="text-sm px-3 py-1.5 rounded bg-campo-600 hover:bg-campo-500 transition-colors"
            >
              {isChat ? 'Dashboard' : 'Chat'}
            </button>
          )}
          {/* Nombre visible en desktop; ícono de perfil en mobile */}
          <button
            type="button"
            onClick={handleUserClick}
            className="flex items-center gap-1.5 text-sm text-campo-100 hover:text-white hover:underline transition-colors"
            title="Ir a Mi cuenta"
          >
            <CircleUser className="w-4 h-4 sm:hidden" aria-hidden="true" />
            <span className="hidden sm:inline">{user.name || user.email}</span>
          </button>
          <button
            onClick={handleLogout}
            className="text-sm bg-campo-800 hover:bg-campo-900 px-3 py-1.5 rounded transition-colors"
          >
            Salir
          </button>
        </div>
      </div>
    </nav>
  );
}
