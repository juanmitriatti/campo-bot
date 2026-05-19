import type { UserField } from '../../hooks/useUserFields';

interface Props {
  fields: UserField[];
  value: number | null;
  onChange: (id: number) => void;
}

export default function FieldSelector({ fields, value, onChange }: Props) {
  if (fields.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-500 dark:text-gray-400">Campo:</label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="text-xs border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-800 dark:text-gray-100 focus:outline-none focus:border-campo-500 focus:ring-1 focus:ring-campo-500 max-w-[200px]"
      >
        {fields.map(f => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
    </div>
  );
}
