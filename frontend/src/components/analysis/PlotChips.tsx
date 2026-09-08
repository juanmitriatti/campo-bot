import type { TreePlot } from '../../hooks/useFieldsTree';

interface Props {
  plots: TreePlot[];
  /** null = todos los lotes. */
  value: number[] | null;
  onChange: (ids: number[] | null) => void;
  disabled?: boolean;
}

/**
 * Selector múltiple de lotes: "Todos los lotes" + un chip por lote. Con
 * "Todos los campos" elegido arriba se deshabilita (los lotes solo tienen
 * sentido dentro de un campo). Mismo look que FieldChips; táctil ≥ 44 px.
 */
export default function PlotChips({ plots, value, onChange, disabled }: Props) {
  const allSelected = value == null;
  const toggle = (id: number) => {
    if (allSelected) { onChange([id]); return; }
    const set = new Set(value);
    if (set.has(id)) set.delete(id); else set.add(id);
    // Sin ninguno seleccionado volvemos a "todos": un alcance vacío no analiza nada.
    onChange(set.size === 0 || set.size === plots.length ? null : [...set].sort((a, b) => a - b));
  };
  const base = 'inline-flex items-center gap-1 min-h-[44px] px-3 rounded-full border text-sm whitespace-nowrap transition-colors';
  const on = 'bg-campo-600 border-campo-600 text-white';
  const off = 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:border-campo-500';

  if (disabled) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400 min-h-[44px] flex items-center">
        Elegí un campo para acotar el análisis a algunos lotes. Con todos los campos se analiza todo.
      </p>
    );
  }
  if (plots.length === 0) {
    return <p className="text-xs text-gray-500 dark:text-gray-400 min-h-[44px] flex items-center">Este campo todavía no tiene lotes.</p>;
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="group" aria-label="Lotes a analizar">
      <button
        type="button"
        aria-pressed={allSelected}
        onClick={() => onChange(null)}
        className={`${base} ${allSelected ? on : off}`}
      >
        Todos los lotes
      </button>
      {plots.map(p => {
        const selected = !allSelected && value!.includes(p.id);
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={selected}
            onClick={() => toggle(p.id)}
            className={`${base} ${selected ? on : off}`}
            title={p.activeCrop ? `${p.name} · ${p.activeCrop}` : p.name}
          >
            {p.name}
            {p.hectares != null && <span className={`text-xs ${selected ? 'text-white/80' : 'text-gray-400'}`}>{p.hectares} ha</span>}
          </button>
        );
      })}
    </div>
  );
}
