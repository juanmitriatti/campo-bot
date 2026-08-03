import { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { apiRequest } from '../api/client';

interface LocalidadMatch {
  nombre: string;
  provincia: string;
  departamento: string | null;
}

interface LookupResponse {
  status: 'exact' | 'disambiguate' | 'suggestions' | 'not_found';
  matches: LocalidadMatch[];
}

/**
 * Input de localidad con autocomplete contra el censo (GET /localidades?q=).
 * Devuelve el string elegido/tipeado vía onChange; al seleccionar del dropdown
 * usa el nombre oficial del censo (el backend igual re-valida al guardar).
 */
export default function LocalidadInput({ value, onChange, placeholder, disabled, className, autoFocus, onEnter, onEscape }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
  onEscape?: () => void;
}) {
  const [matches, setMatches] = useState<LocalidadMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const justPicked = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (justPicked.current) { justPicked.current = false; return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = value.trim();
    if (q.length < 2) { setMatches([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await apiRequest<LookupResponse>(`/localidades?q=${encodeURIComponent(q)}`);
        setMatches(r.matches);
        setOpen(r.matches.length > 0);
        setHighlight(-1);
      } catch {
        setMatches([]); setOpen(false);
      }
    }, 220);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [value]);

  // Cerrar al clickear afuera
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const pick = (m: LocalidadMatch) => {
    justPicked.current = true;
    onChange(m.nombre);
    setOpen(false);
    setMatches([]);
  };

  return (
    <div className="relative" ref={rootRef}>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder ?? 'Localidad'}
        disabled={disabled}
        autoFocus={autoFocus}
        onKeyDown={e => {
          if (open && matches.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, matches.length - 1)); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); return; }
            if (e.key === 'Enter' && highlight >= 0) { e.preventDefault(); pick(matches[highlight]); return; }
          }
          if (e.key === 'Enter') onEnter?.();
          if (e.key === 'Escape') { if (open) { setOpen(false); } else { onEscape?.(); } }
        }}
        className={className ?? 'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50'}
        autoComplete="off"
      />
      {open && matches.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full max-h-56 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md shadow-lg text-sm">
          {matches.map((m, i) => (
            <li key={`${m.nombre}|${m.provincia}|${i}`}>
              <button
                type="button"
                onMouseDown={e => { e.preventDefault(); pick(m); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left ${
                  i === highlight ? 'bg-campo-50 dark:bg-campo-900/30' : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <span className="text-gray-800 dark:text-gray-100">{m.nombre}</span>
                <span className="text-gray-400 dark:text-gray-500 text-xs truncate">{m.provincia}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
