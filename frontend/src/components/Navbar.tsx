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

  const linkClass = (path: string) =>
    `text-sm px-3 py-1.5 rounded transition-colors ${
      location.pathname === path
        ? 'bg-campo-500 text-white'
        : 'text-campo-100 hover:bg-campo-800'
    }`;

  return (
    <nav className="bg-campo-700 text-white shadow-md">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tracking-tight cursor-pointer" onClick={() => navigate('/dashboard')}>Campo Bot</span>
          {plan && (
            <span className="text-xs bg-campo-500 px-2 py-0.5 rounded-full font-medium">
              {plan.display_name}
            </span>
          )}
          <div className="flex items-center gap-1 ml-4">
            <button onClick={() => navigate('/dashboard')} className={linkClass('/dashboard')}>
              Dashboard
            </button>
            <button onClick={() => navigate('/chat')} className={linkClass('/chat')}>
              Chat de prueba
            </button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-campo-100">
            {user.name || user.email}
          </span>
          <button
            onClick={handleLogout}
            className="text-sm bg-campo-800 hover:bg-campo-900 px-3 py-1.5 rounded transition-colors"
          >
            Cerrar sesion
          </button>
        </div>
      </div>
    </nav>
  );
}
