import { MapPin } from 'lucide-react';
import type { UserField } from '../../hooks/useUserFields';

interface Props {
  fields: UserField[];
  value: number | null;
  onChange: (id: number | null) => void;
  /** Render variant: 'inline' for top-bar, 'sidebar' for the left navigation. */
  variant?: 'inline' | 'sidebar';
}

export default function FieldSelector({ fields, value, onChange, variant = 'inline' }: Props) {
  if (fields.length === 0) return null;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    onChange(v === 'all' ? null : Number(v));
  };

  if (variant === 'sidebar') {
    return (
      <div className="px-3 pt-3 pb-2">
        <label className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 font-semibold flex items-center gap-1 mb-1.5">
          <MapPin className="w-3 h-3" /> Campo
        </label>
        <select
          value={value == null ? 'all' : value}
          onChange={handleChange}
          className="w-full text-sm font-medium border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 dark:text-gray-100 focus:outline-none focus:border-campo-500 focus:ring-1 focus:ring-campo-500 transition-colors hover:border-gray-300"
        >
          <option value="all">📂 Todos los campos</option>
          {fields.map(f => (
            <option key={f.id} value={f.id}>📍 {f.name}</option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-500 dark:text-gray-300">Campo:</label>
      <select
        value={value == null ? 'all' : value}
        onChange={handleChange}
        className="text-xs border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-800 dark:text-gray-100 focus:outline-none focus:border-campo-500 focus:ring-1 focus:ring-campo-500 max-w-[200px]"
      >
        <option value="all">Todos los campos</option>
        {fields.map(f => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
    </div>
  );
}
