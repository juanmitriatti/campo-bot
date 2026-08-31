import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client';
import type { ImportPreview, FiltersResponse } from '../api/animals';
import { CATEGORY_LABELS, formatTag } from '../api/animals';

/**
 * Importación de lecturas de caravanas (lo que baja un lector RFID o un CSV).
 *
 * Flujo: preview → confirmar → aplicar. NUNCA se aplica a ciegas: el productor
 * ve cuántas encontró, dónde están y qué no cuadra antes de mover nada. Las
 * cuatro categorías del resumen suman el total leído, así que puede cuadrar
 * "leí 90, encontré 87" sin adivinar dónde fueron las otras 3.
 */
export default function AnimalImportPanel() {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fields, setFields] = useState<FiltersResponse['fields']>([]);
  const [corrals, setCorrals] = useState<FiltersResponse['corrals']>([]);
  const [dest, setDest] = useState('');           // "plot:12" | "corral:3"
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<FiltersResponse>('/livestock/filters')
      .then(r => { setFields(r.fields); setCorrals(r.corrals || []); })
      .catch(() => {});
  }, []);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const runPreview = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await apiRequest<ImportPreview>('/animals/import', {
        method: 'POST',
        body: JSON.stringify({ text, intended_action: 'movimiento' }),
      }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No pude procesar la lista');
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!preview || !dest) return;
    const [kind, id] = dest.split(':');
    setApplying(true);
    setError(null);
    try {
      const r = await apiRequest<{ moved: number; skipped: Array<{ reason: string }> }>(
        `/animals/batches/${preview.batchId}/apply`,
        {
          method: 'POST',
          body: JSON.stringify(kind === 'plot' ? { plot_id: Number(id) } : { corral_id: Number(id) }),
        },
      );
      const skipped = r.skipped.length > 0
        ? ` ${r.skipped.length} no se movieron (${[...new Set(r.skipped.map(s => s.reason))].join(', ')}).`
        : '';
      setResult(`Listo: ${r.moved} animal${r.moved === 1 ? '' : 'es'} movido${r.moved === 1 ? '' : 's'}.${skipped}`);
      setPreview(null);
      setText('');
      setDest('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No pude aplicar el lote');
    } finally {
      setApplying(false);
    }
  };

  const byLocation = preview
    ? preview.matched.reduce<Record<string, number>>((acc, m) => {
        const k = m.location ?? 'sin ubicación conocida';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {})
    : {};

  return (
    <div className="px-4 py-4 max-w-3xl space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">Importar lecturas de caravanas</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Pegá lo que bajó el lector (un número por línea) o subí el archivo. Primero te
          muestro qué encontré; no se mueve nada hasta que confirmes.
        </p>
      </div>

      <div className="space-y-2">
        <textarea
          value={text}
          onChange={e => { setText(e.target.value); setPreview(null); setResult(null); }}
          rows={8}
          placeholder={'032010001234567\n032010001234568\n032010001234569'}
          className="w-full font-mono text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-md px-3 py-2"
        />
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".csv,.txt"
            onChange={e => { const f = e.target.files?.[0]; if (f) readFile(f); }}
            className="text-sm text-gray-600 dark:text-gray-300"
          />
          <button
            onClick={runPreview}
            disabled={!text.trim() || loading}
            className="ml-auto px-4 py-1.5 rounded-md bg-campo-600 text-white text-sm disabled:opacity-50 hover:bg-campo-700"
          >
            {loading ? 'Procesando…' : 'Ver qué encontré'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {result && (
        <div className="bg-campo-50 dark:bg-campo-900/30 border border-campo-200 dark:border-campo-800 rounded-md p-3 text-sm text-campo-800 dark:text-campo-200">
          {result}
        </div>
      )}

      {preview && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-md">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <p className="text-sm text-gray-900 dark:text-gray-100">
              Leí <strong>{preview.summary.raw}</strong> identificadores y encontré <strong>{preview.summary.matched}</strong> animales.
            </p>
            <ul className="mt-2 text-sm text-gray-600 dark:text-gray-300 space-y-0.5">
              {Object.entries(byLocation)
                .sort((a, b) => b[1] - a[1])
                .map(([loc, n]) => <li key={loc}>• {n} en {loc}</li>)}
              {preview.summary.unknown > 0 && <li>• {preview.summary.unknown} sin registrar en tu rodeo</li>}
              {preview.summary.duplicates > 0 && <li>• {preview.summary.duplicates} repetidos en la lectura</li>}
              {preview.summary.invalid > 0 && <li>• {preview.summary.invalid} ilegibles</li>}
            </ul>
          </div>

          {preview.summary.matched > 0 ? (
            <div className="px-4 py-3 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col">
                  <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Mover a</label>
                  <select
                    value={dest}
                    onChange={e => setDest(e.target.value)}
                    className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm min-w-56"
                  >
                    <option value="">Elegí destino…</option>
                    {fields.map(f => (
                      <optgroup key={f.id} label={f.name}>
                        {f.plots.map(p => <option key={p.id} value={`plot:${p.id}`}>Lote {p.name}</option>)}
                      </optgroup>
                    ))}
                    {corrals.length > 0 && (
                      <optgroup label="Feedlot">
                        {corrals.map(c => <option key={c.id} value={`corral:${c.id}`}>Corral {c.name}{c.field_name ? ` (${c.field_name})` : ''}</option>)}
                      </optgroup>
                    )}
                  </select>
                </div>
                <button
                  onClick={apply}
                  disabled={!dest || applying}
                  className="px-4 py-1.5 rounded-md bg-campo-600 text-white text-sm disabled:opacity-50 hover:bg-campo-700"
                >
                  {applying ? 'Aplicando…' : `Mover ${preview.summary.matched}`}
                </button>
              </div>

              <details className="text-sm">
                <summary className="cursor-pointer text-gray-600 dark:text-gray-300">Ver el detalle</summary>
                <div className="mt-2 max-h-64 overflow-y-auto">
                  <table className="min-w-full text-xs">
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {preview.matched.map(m => (
                        <tr key={m.animalId}>
                          <td className="py-1 pr-3 font-mono">{formatTag(m.value)}</td>
                          <td className="py-1 pr-3">{CATEGORY_LABELS[m.category] ?? m.category}</td>
                          <td className="py-1 text-gray-500 dark:text-gray-400">{m.location ?? 'sin ubicación'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.unknown.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-gray-700 dark:text-gray-200">Sin registrar en tu rodeo</p>
                      <p className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{preview.unknown.join(', ')}</p>
                    </div>
                  )}
                  {preview.invalid.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-gray-700 dark:text-gray-200">Ilegibles</p>
                      <p className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">
                        {preview.invalid.map(i => i.value).join(', ')}
                      </p>
                    </div>
                  )}
                </div>
              </details>
            </div>
          ) : (
            <div className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
              Ninguna de esas caravanas está registrada en tu rodeo todavía, así que no hay nada para mover.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
