import { Sun, Moon } from 'lucide-react';
import type { Theme } from '../../hooks/useTheme';

interface Props {
  theme: Theme;
  onToggle: () => void;
}

export default function ThemeToggle({ theme, onToggle }: Props) {
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
      title={isDark ? 'Modo claro' : 'Modo oscuro'}
      className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-800 border border-gray-200 bg-white rounded-md px-3 py-1.5 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:text-white dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
    >
      {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
      {isDark ? 'Claro' : 'Oscuro'}
    </button>
  );
}
