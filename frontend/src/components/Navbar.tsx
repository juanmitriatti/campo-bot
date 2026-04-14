import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Navbar() {
  const { user, plan, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  if (!user) return null;

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
          <button
            onClick={() => navigate(isChat ? '/dashboard' : '/chat')}
            className="text-sm px-3 py-1.5 rounded bg-campo-600 hover:bg-campo-500 transition-colors"
          >
            {isChat ? 'Dashboard' : 'Chat'}
          </button>
          <span className="text-sm text-campo-100 hidden sm:inline">
            {user.name || user.email}
          </span>
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
