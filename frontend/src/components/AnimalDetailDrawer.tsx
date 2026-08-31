import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client';
import type { AnimalDetail, AnimalEvent } from '../api/animals';
import {
  CATEGORY_LABELS, STATUS_LABELS, EVENT_LABELS,
  animalTag, formatTag, formatDate,
} from '../api/animals';

/**
 * Ficha del animal: datos, historial de caravanas, línea de tiempo y evolución
 * de peso.
 *
 * El historial de identificaciones se muestra COMPLETO (incluidas las retiradas)
 * porque ese encadenamiento es el activo regulatorio: la Res. SENASA 841/2025
 * Art. 11(d) exige que cada caravana nueva referencie a la anterior.
 */
export default function AnimalDetailDrawer({
  animalId, onClose, onChanged,
}: {
  animalId: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [detail, setDetail] = useState<AnimalDetail | null>(null);
  const [events, setEvents] = useState<AnimalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [d, t] = await Promise.all([
        apiRequest<AnimalDetail>(`/animals/${animalId}`),
        apiRequest<{ events: AnimalEvent[] }>(`/animals/${animalId}/timeline`),
      ]);
      setDetail(d);
      setEvents(t.events);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No pude cargar el animal');
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [animalId]);

  const submitReplacement = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = newTag.trim();
    if (!value) return;
    setSaving(true);
    setReplaceError(null);
    try {
      await apiRequest(`/animals/${animalId}/identifications`, {
        method: 'POST',
        body: { value, reason: 'reemplazo' },
      });
      setNewTag('');
      setReplacing(false);
      await load();
      onChanged?.();
    } catch (err: unknown) {
      setReplaceError(err instanceof Error ? err.message : 'No pude asignar la caravana');
    } finally {
      setSaving(false);
    }
  };

  const a = detail?.animal;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg h-full overflow-y-auto bg-white dark:bg-gray-800 shadow-xl">
        <div className="sticky top-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-5 py-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {a ? (animalTag(a) ? formatTag(animalTag(a)!) : 'Animal sin caravana') : 'Cargando…'}
            </h2>
            {a && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {CATEGORY_LABELS[a.category] ?? a.category} · {a.sex === 'H' ? 'Hembra' : 'Macho'}
                {a.breed_name ? ` · ${a.breed_name}` : ''}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
        </div>

        {error && (
          <div className="m-5 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {a && (
          <div className="px-5 py-4 space-y-6">
            {/* Datos */}
            <section>
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-gray-500 dark:text-gray-400">Estado</dt>
                <dd className="text-gray-900 dark:text-gray-100">
                  {STATUS_LABELS[a.status]?.emoji} {STATUS_LABELS[a.status]?.label ?? a.status}
                </dd>
                <dt className="text-gray-500 dark:text-gray-400">Ubicación</dt>
                <dd className="text-gray-900 dark:text-gray-100">
                  {a.plot_name ? `Lote ${a.plot_name}` : a.corral_name ? `Corral ${a.corral_name}` : a.field_name ?? '—'}
                </dd>
                <dt className="text-gray-500 dark:text-gray-400">Nacimiento</dt>
                <dd className="text-gray-900 dark:text-gray-100">{formatDate(a.birth_date)}</dd>
                <dt className="text-gray-500 dark:text-gray-400">Ingreso</dt>
                <dd className="text-gray-900 dark:text-gray-100">{formatDate(a.entry_date)}</dd>
                {a.exit_date && (
                  <>
                    <dt className="text-gray-500 dark:text-gray-400">Salida</dt>
                    <dd className="text-gray-900 dark:text-gray-100">{formatDate(a.exit_date)}</dd>
                  </>
                )}
              </dl>
            </section>

            {/* Peso */}
            <section>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Peso</h3>
              {detail.weights.weighings.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">Sin pesajes registrados.</p>
              ) : (
                <>
                  <ul className="text-sm space-y-1">
                    {detail.weights.weighings.map((w, i) => (
                      <li key={i} className="flex justify-between">
                        <span className="text-gray-500 dark:text-gray-400">{formatDate(w.date)}</span>
                        <span className="text-gray-900 dark:text-gray-100 font-medium">{w.weightKg} kg</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                    {detail.weights.overallGdpKgDay != null
                      ? <>📈 GDP promedio: <strong>{detail.weights.overallGdpKgDay.toFixed(3)} kg/día</strong></>
                      // Con un solo pesaje no se inventa una ganancia.
                      : <span className="text-gray-500 dark:text-gray-400">Con un solo pesaje todavía no se puede calcular la ganancia diaria.</span>}
                  </p>
                </>
              )}
            </section>

            {/* Caravanas */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Caravanas</h3>
                {!replacing && (
                  <button onClick={() => setReplacing(true)} className="text-sm text-campo-700 dark:text-campo-400 hover:underline">
                    Reemplazar
                  </button>
                )}
              </div>

              {replacing && (
                <form onSubmit={submitReplacement} className="mb-3 space-y-2">
                  <input
                    value={newTag}
                    onChange={e => { setNewTag(e.target.value); setReplaceError(null); }}
                    placeholder="Caravana nueva"
                    autoFocus
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    La caravana actual queda en el historial, referenciada por la nueva.
                  </p>
                  {replaceError && <p className="text-xs text-red-600 dark:text-red-400">{replaceError}</p>}
                  <div className="flex gap-2">
                    <button type="submit" disabled={saving} className="px-3 py-1.5 rounded-md bg-campo-600 text-white text-sm disabled:opacity-50">
                      {saving ? 'Guardando…' : 'Guardar'}
                    </button>
                    <button type="button" onClick={() => { setReplacing(false); setReplaceError(null); }} className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm">
                      Cancelar
                    </button>
                  </div>
                </form>
              )}

              <ul className="text-sm space-y-2">
                {detail.identifications.map(i => (
                  <li key={i.id} className="flex items-start justify-between gap-3">
                    <div>
                      <span className={`font-mono text-xs ${i.is_current ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 line-through'}`}>
                        {formatTag(i.value)}
                      </span>
                      <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{i.id_type}</span>
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 text-right whitespace-nowrap">
                      {i.is_current
                        ? <span className="text-campo-700 dark:text-campo-400">vigente</span>
                        : `retirada ${formatDate(i.removed_date)}${i.removal_reason ? ` (${i.removal_reason})` : ''}`}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {/* Línea de tiempo */}
            <section>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Historial</h3>
              {events.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">Todavía no tiene eventos registrados.</p>
              ) : (
                <ol className="space-y-2 text-sm">
                  {events.map(e => {
                    const label = EVENT_LABELS[e.event_type] ?? { emoji: '•', label: e.event_type };
                    const detailText = e.numeric_value != null
                      ? `${Number(e.numeric_value)}${e.unit ? ` ${e.unit}` : ''}`
                      : e.from_ref && e.to_ref ? `${e.from_ref} → ${e.to_ref}`
                      : e.to_ref ?? e.text_value ?? '';
                    return (
                      <li key={e.id} className="flex gap-3">
                        <span className="text-xs text-gray-500 dark:text-gray-400 w-20 shrink-0">{formatDate(e.event_date)}</span>
                        <span>{label.emoji}</span>
                        <span className="text-gray-900 dark:text-gray-100">
                          {label.label}
                          {detailText && <span className="text-gray-500 dark:text-gray-400"> — {detailText}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
