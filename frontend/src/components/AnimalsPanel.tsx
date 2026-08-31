import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import AnimalDetailDrawer from './AnimalDetailDrawer';
import type { Animal, AnimalsResponse, FiltersResponse } from '../api/animals';
import { CATEGORY_LABELS, STATUS_LABELS, formatTag, animalTag } from '../api/animals';

/**
 * Listado de animales INDIVIDUALES.
 *
 * Convive con la pestaña "Grupos" sin reemplazarla: el productor que no
 * caravaneó nada ve acá el empty state y sigue trabajando por grupos, que es el
 * camino principal.
 */
export default function AnimalsPanel() {
  const [data, setData] = useState<AnimalsResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Animal | null>(null);

  const [fields, setFields] = useState<FiltersResponse['fields']>([]);
  const [fieldId, setFieldId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('activo');
  const [search, setSearch] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);

  const limit = 25;

  useEffect(() => {
    apiRequest<FiltersResponse>('/livestock/filters')
      .then(r => setFields(r.fields))
      .catch(() => {});
  }, []);

  const fetchAnimals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit), status });
      if (fieldId) params.set('field_id', fieldId);
      if (plotId) params.set('plot_id', plotId);
      if (category) params.set('category', category);
      setData(await apiRequest<AnimalsResponse>(`/animals?${params}`));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar animales');
    } finally {
      setLoading(false);
    }
  }, [page, fieldId, plotId, category, status]);

  useEffect(() => { fetchAnimals(); }, [fetchAnimals]);

  /** Busca una caravana puntual y abre su ficha. */
  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const ref = search.trim();
    if (!ref) return;
    setSearchError(null);
    try {
      setSelected(await apiRequest<Animal>(`/animals/lookup?ref=${encodeURIComponent(ref)}`));
    } catch {
      setSearchError(`No encontré ningún animal con la caravana ${ref}.`);
    }
  };

  const plotsForField = fieldId
    ? fields.find(f => String(f.id) === fieldId)?.plots ?? []
    : [];

  if (loading && !data) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4 text-red-700 dark:text-red-300 text-sm">
        {error}
        <button onClick={fetchAnimals} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  const noFiltersApplied = !fieldId && !plotId && !category && status === 'activo';
  const isEmptyOverall = data && data.total === 0 && noFiltersApplied;

  return (
    <div>
      {/* Filtros + búsqueda por caravana */}
      <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 text-sm">
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Campo</label>
          <select
            value={fieldId}
            onChange={e => { setFieldId(e.target.value); setPlotId(''); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todos</option>
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Lote</label>
          <select
            value={plotId}
            onChange={e => { setPlotId(e.target.value); setPage(1); }}
            disabled={!fieldId}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm disabled:bg-gray-100 dark:disabled:bg-gray-700"
          >
            <option value="">Todos</option>
            {plotsForField.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Categoría</label>
          <select
            value={category}
            onChange={e => { setCategory(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">Todas</option>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Estado</label>
          <select
            value={status}
            onChange={e => { setStatus(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm"
          >
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <form onSubmit={lookup} className="flex flex-col ml-auto">
          <label className="text-xs text-gray-500 dark:text-gray-300 mb-1">Buscar caravana</label>
          <div className="flex gap-2">
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setSearchError(null); }}
              placeholder="032 01 0001234567"
              className="border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md px-2 py-1.5 text-sm w-52"
            />
            <button
              type="submit"
              className="px-3 py-1.5 rounded-md bg-campo-600 text-white text-sm hover:bg-campo-700"
            >
              Ver
            </button>
          </div>
        </form>
      </div>

      {searchError && (
        <div className="mx-4 mt-3 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2">
          {searchError}
        </div>
      )}

      {isEmptyOverall ? (
        <div className="px-6 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
          <p className="text-base text-gray-700 dark:text-gray-200 mb-2">Todavía no tenés animales con caravana.</p>
          <p className="max-w-lg mx-auto">
            No hace falta: podés seguir manejando el rodeo por grupos como hasta ahora.
            La identificación individual sirve cuando querés seguir un animal
            puntual — su historial, sus pesadas, su sanidad.
          </p>
          <p className="mt-3">
            Para empezar, importá las lecturas del lector en la pestaña <strong>Importar</strong>,
            o decile al bot <em>«dar de alta una vaca con caravana 032 01 0001234567»</em>.
          </p>
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
          Ningún animal cumple esos filtros.
        </div>
      ) : (
        <>
          <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
            {data?.total} animal{data?.total === 1 ? '' : 'es'}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-300">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Caravana</th>
                  <th className="text-left font-medium px-4 py-2">Categoría</th>
                  <th className="text-left font-medium px-4 py-2">Sexo</th>
                  <th className="text-left font-medium px-4 py-2">Raza</th>
                  <th className="text-left font-medium px-4 py-2">Ubicación</th>
                  <th className="text-left font-medium px-4 py-2">Estado</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {data?.items.map(a => (
                  <tr key={a.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="px-4 py-2 font-mono text-xs">
                      {animalTag(a) ? formatTag(animalTag(a)!) : <span className="text-gray-400">sin caravana</span>}
                    </td>
                    <td className="px-4 py-2">{CATEGORY_LABELS[a.category] ?? a.category}</td>
                    <td className="px-4 py-2">{a.sex === 'H' ? 'Hembra' : 'Macho'}</td>
                    <td className="px-4 py-2">{a.breed_name ?? a.breed_text ?? '—'}</td>
                    <td className="px-4 py-2">
                      {a.plot_name ? `Lote ${a.plot_name}` : a.corral_name ? `Corral ${a.corral_name}` : a.field_name ?? '—'}
                    </td>
                    <td className="px-4 py-2">
                      {STATUS_LABELS[a.status]?.emoji} {STATUS_LABELS[a.status]?.label ?? a.status}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => setSelected(a)} className="text-campo-700 dark:text-campo-400 hover:underline">
                        Ver ficha
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 text-sm">
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40"
              >
                Anterior
              </button>
              <span className="text-gray-500 dark:text-gray-400">Página {data.page} de {data.totalPages}</span>
              <button
                disabled={page >= data.totalPages}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40"
              >
                Siguiente
              </button>
            </div>
          )}
        </>
      )}

      {selected && (
        <AnimalDetailDrawer
          animalId={selected.id}
          onClose={() => setSelected(null)}
          onChanged={fetchAnimals}
        />
      )}
    </div>
  );
}
