import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { CircleUser, ChevronDown, UserCog, BookOpen, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface NavbarProps {
  onUserClick?: () => void;
}

export default function Navbar({ onUserClick }: NavbarProps) {
  const { user, plan, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Cerrar el dropdown al clickear afuera o apretar Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const handleLogout = () => {
    setMenuOpen(false);
    logout();
    navigate('/login');
  };

  const goToAccount = () => {
    setMenuOpen(false);
    if (onUserClick) {
      onUserClick();
    } else {
      navigate('/dashboard');
    }
  };

  if (!user) return null;

  const isAdmin = user.role === 'admin';
  const isChat = location.pathname === '/chat';
  const displayName = [user.name, user.last_name].filter(Boolean).join(' ') || user.email;

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

          {/* Menú de usuario */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(o => !o)}
              className="flex items-center gap-1.5 text-sm text-campo-100 hover:text-white px-2 py-1.5 rounded-md hover:bg-campo-600 transition-colors"
              title="Menú de usuario"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <CircleUser className="w-5 h-5" aria-hidden="true" />
              <span className="hidden sm:inline max-w-[160px] truncate">{displayName}</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${menuOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1.5 z-50"
              >
                <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-700">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{displayName}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
                </div>
                <button
                  role="menuitem"
                  onClick={goToAccount}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <UserCog className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                  Mi cuenta
                </button>
                <button
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); window.open('/guia', '_blank', 'noopener'); }}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <BookOpen className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                  Guía de uso
                </button>
                <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                <button
                  role="menuitem"
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Cerrar sesión
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
