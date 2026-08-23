import { Layers, MapPin } from 'lucide-react';
import type { UserField } from '../../hooks/useUserFields';

interface Props {
  fields: UserField[];
  value: number | null;
  onChange: (id: number | null) => void;
}

/**
 * The field filter, as chips in the content area.
 *
 * It used to live inside the sidebar, which was wrong twice over: it filters
 * everything on screen (so it belongs with the content, not with navigation),
 * and the sidebar is hidden on mobile — where the filter simply did not exist.
 */
export default function FieldChips({ fields, value, onChange }: Props) {
  if (fields.length === 0) return null;

  const chips: Array<{ id: number | null; label: string }> = [
    { id: null, label: 'Todos los campos' },
    ...fields.map(f => ({ id: f.id as number | null, label: f.name })),
  ];

  return (
    <div
      className="flex items-center gap-2 overflow-x-auto pb-1 -mb-1"
      role="group"
      aria-label="Filtrar por campo"
    >
      {chips.map(c => {
        const active = c.id === value;
        const Icon = c.id == null ? Layers : MapPin;
        return (
          <button
            key={c.id ?? 'all'}
            type="button"
            onClick={() => onChange(c.id)}
            aria-pressed={active}
            className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 min-h-[36px] text-xs transition-colors ${
              active
                ? 'bg-gray-900 dark:bg-gray-100 border-gray-900 dark:border-gray-100 text-white dark:text-gray-900 font-semibold'
                : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            <Icon className="w-3 h-3 shrink-0" />
            <span className="whitespace-nowrap">{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}
