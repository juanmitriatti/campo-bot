import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { Pencil } from 'lucide-react';

interface Plot {
  id: number;
  name: string;
  hectares: number | null;
  activeCrop: string | null;
}

interface Field {
  id: number;
  name: string;
  city: string | null;
  plots: Plot[];
}

interface FieldsResponse {
  fields: Field[];
}

export default function FieldsTab() {
  const [fields, setFields] = useState<Field[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Inline editing state
  const [editingFieldId, setEditingFieldId] = useState<number | null>(null);
  const [fieldNameDraft, setFieldNameDraft] = useState('');
  const [fieldNameError, setFieldNameError] = useState<string | null>(null);

  const [editingPlotId, setEditingPlotId] = useState<number | null>(null);
  const [plotNameDraft, setPlotNameDraft] = useState('');
  const [plotHaDraft, setPlotHaDraft] = useState('');
  const [plotError, setPlotError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);

  const fetchFields = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<FieldsResponse>('/fields-tree');
      setFields(result.fields);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar campos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchFields(); }, [fetchFields]);

  const startEditField = (f: Field) => {
    setEditingFieldId(f.id);
    setFieldNameDraft(f.name);
    setFieldNameError(null);
    setEditingPlotId(null);
  };

  const cancelEditField = () => {
    setEditingFieldId(null);
    setFieldNameError(null);
  };

  const saveField = async (id: number) => {
    const name = fieldNameDraft.trim();
    if (!name) { setFieldNameError('El nombre no puede estar vacío'); return; }
    setSaving(true);
    setFieldNameError(null);
    try {
      await apiRequest(`/fields/${id}`, { method: 'PATCH', body: { name } });
      setEditingFieldId(null);
      await fetchFields();
    } catch (err: unknown) {
      setFieldNameError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const startEditPlot = (p: Plot) => {
    setEditingPlotId(p.id);
    setPlotNameDraft(p.name);
    setPlotHaDraft(p.hectares != null ? String(p.hectares) : '');
    setPlotError(null);
    setEditingFieldId(null);
  };

  const cancelEditPlot = () => {
    setEditingPlotId(null);
    setPlotError(null);
  };

  const savePlot = async (id: number) => {
    const name = plotNameDraft.trim() || undefined;
    const hectaresRaw = plotHaDraft.trim();
    const hectares = hectaresRaw ? Number(hectaresRaw) : undefined;
    if (name === '') { setPlotError('El nombre no puede estar vacío'); return; }
    setSaving(true);
    setPlotError(null);
    try {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (hectares !== undefined) body.hectares = hectares;
      await apiRequest(`/plots/${id}`, { method: 'PATCH', body });
      setEditingPlotId(null);
      await fetchFields();
    } catch (err: unknown) {
      setPlotError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-campo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4 text-red-700 dark:text-red-300 text-sm">
        {error}
        <button onClick={fetchFields} className="ml-2 underline">Reintentar</button>
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center text-gray-500 dark:text-gray-400 text-sm">
        Todavía no tenés campos. Creálos desde el chat:{' '}
        <em className="font-medium text-gray-700 dark:text-gray-300">tengo el campo La Esperanza en Pergamino</em>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {fields.map(f => {
        const totalHa = f.plots.reduce((s, p) => s + (p.hectares ?? 0), 0);
        return (
          <div key={f.id} className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
            {/* Field header */}
            <div className="flex items-start justify-between mb-1">
              <div className="flex-1 min-w-0">
                {editingFieldId === f.id ? (
                  <div className="space-y-1">
                    <input
                      value={fieldNameDraft}
                      onChange={e => setFieldNameDraft(e.target.value)}
                      className="text-base font-semibold border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-2 py-1 w-full focus:ring-2 focus:ring-campo-500 outline-none"
                      autoFocus
                      onKeyDown={e => { if (e.key === 'Enter') void savePlot(f.id); if (e.key === 'Escape') cancelEditField(); }}
                    />
                    {fieldNameError && <p className="text-xs text-red-600 dark:text-red-400">{fieldNameError}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={() => void saveField(f.id)}
                        disabled={saving}
                        className="text-xs bg-campo-600 text-white rounded-md px-3 py-1.5 disabled:opacity-50 hover:bg-campo-700"
                      >
                        Guardar
                      </button>
                      <button onClick={cancelEditField} className="text-xs text-gray-500 dark:text-gray-400">Cancelar</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{f.name}</h3>
                    <button
                      onClick={() => startEditField(f)}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                      title="Renombrar campo"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {f.city ?? 'Sin ubicación'}{totalHa > 0 ? ` · ${totalHa} ha totales` : ''}
                </p>
              </div>
            </div>

            {/* Plots */}
            {f.plots.length > 0 && (
              <div className="mt-3 space-y-2 pl-2 border-l-2 border-gray-100 dark:border-gray-700">
                {f.plots.map(p => (
                  <div key={p.id} className="pl-2">
                    {editingPlotId === p.id ? (
                      <div className="space-y-1">
                        <div className="flex gap-2 flex-wrap">
                          <input
                            value={plotNameDraft}
                            onChange={e => setPlotNameDraft(e.target.value)}
                            placeholder="Nombre del lote"
                            className="text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-2 py-1 flex-1 min-w-[120px] focus:ring-2 focus:ring-campo-500 outline-none"
                            autoFocus
                          />
                          <input
                            type="number"
                            value={plotHaDraft}
                            onChange={e => setPlotHaDraft(e.target.value)}
                            placeholder="Hectáreas"
                            min="0.01"
                            max="100000"
                            step="0.01"
                            className="text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-2 py-1 w-28 focus:ring-2 focus:ring-campo-500 outline-none"
                          />
                        </div>
                        {plotError && <p className="text-xs text-red-600 dark:text-red-400">{plotError}</p>}
                        <div className="flex gap-2">
                          <button
                            onClick={() => void savePlot(p.id)}
                            disabled={saving}
                            className="text-xs bg-campo-600 text-white rounded-md px-3 py-1.5 disabled:opacity-50 hover:bg-campo-700"
                          >
                            Guardar
                          </button>
                          <button onClick={cancelEditPlot} className="text-xs text-gray-500 dark:text-gray-400">Cancelar</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-gray-800 dark:text-gray-100">{p.name}</span>
                        {p.hectares != null && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">{p.hectares} ha</span>
                        )}
                        {p.activeCrop && (
                          <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 px-1.5 py-0.5 rounded">
                            {p.activeCrop}
                          </span>
                        )}
                        {!p.activeCrop && (
                          <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                        )}
                        <button
                          onClick={() => startEditPlot(p)}
                          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 ml-1"
                          title="Editar lote"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
