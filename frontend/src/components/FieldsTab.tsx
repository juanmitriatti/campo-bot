import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { Pencil, Plus, MapPin } from 'lucide-react';
import LocalidadInput from './LocalidadInput';
import TabHeader from './TabHeader';
import SenasaFields from './SenasaFields';

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
  location_method: string | null;
  has_coords: boolean;
  renspa: string | null;
  cuig: string | null;
  senasa_titular: string | null;
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

  // Alta manual de campo
  const [addingField, setAddingField] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldCity, setNewFieldCity] = useState('');
  const [newFieldError, setNewFieldError] = useState<string | null>(null);

  const createField = async () => {
    const name = newFieldName.trim();
    if (!name) { setNewFieldError('El nombre no puede estar vacío'); return; }
    setSaving(true);
    setNewFieldError(null);
    try {
      await apiRequest('/fields', { method: 'POST', body: { name, city: newFieldCity.trim() || undefined } });
      setAddingField(false);
      setNewFieldName('');
      setNewFieldCity('');
      await fetchFields();
    } catch (err: unknown) {
      setNewFieldError(err instanceof Error ? err.message : 'Error al crear el campo');
    } finally {
      setSaving(false);
    }
  };

  // Edición de localidad de un campo existente
  const [editingCityFieldId, setEditingCityFieldId] = useState<number | null>(null);
  const [cityDraft, setCityDraft] = useState('');
  const [cityError, setCityError] = useState<string | null>(null);
  const [cityWarning, setCityWarning] = useState<string | null>(null);

  const startEditCity = (f: Field) => {
    setEditingCityFieldId(f.id);
    setCityDraft(f.city ?? '');
    setCityError(null);
    setCityWarning(null);
  };

  const saveCity = async (id: number) => {
    setSaving(true);
    setCityError(null);
    try {
      const r = await apiRequest<{ field: unknown; cityWarning: string | null }>(`/fields/${id}`, {
        method: 'PATCH', body: { city: cityDraft.trim() },
      });
      setEditingCityFieldId(null);
      setCityWarning(r.cityWarning ?? null);
      await fetchFields();
    } catch (err: unknown) {
      setCityError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const addFieldBlock = addingField ? (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-campo-300 dark:border-campo-700 p-4 space-y-2">
      <p className="text-sm font-medium text-gray-800 dark:text-gray-100">Nuevo campo</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={newFieldName}
          onChange={e => setNewFieldName(e.target.value)}
          placeholder="Nombre del campo"
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') void createField(); if (e.key === 'Escape') setAddingField(false); }}
          className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 outline-none"
        />
        <div className="flex-1">
          <LocalidadInput
            value={newFieldCity}
            onChange={setNewFieldCity}
            placeholder="Localidad (opcional — habilita clima y alertas)"
            onEnter={() => void createField()}
            onEscape={() => setAddingField(false)}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 outline-none"
          />
        </div>
      </div>
      {newFieldError && <p className="text-xs text-red-600 dark:text-red-400">{newFieldError}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => void createField()}
          disabled={saving}
          className="text-sm bg-campo-600 text-white rounded-md px-4 py-2 disabled:opacity-50 hover:bg-campo-700 font-medium"
        >
          {saving ? 'Creando…' : 'Crear campo'}
        </button>
        <button
          onClick={() => { setAddingField(false); setNewFieldError(null); }}
          className="text-sm text-gray-500 dark:text-gray-400 px-3 py-2 hover:text-gray-700 dark:hover:text-gray-200"
        >
          Cancelar
        </button>
      </div>
    </div>
  ) : (
    <button
      onClick={() => setAddingField(true)}
      className="w-full flex items-center justify-center gap-1.5 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg py-3 text-sm text-gray-500 dark:text-gray-400 hover:border-campo-400 hover:text-campo-700 dark:hover:text-campo-400 transition-colors"
    >
      <Plus className="w-4 h-4" /> Agregar campo
    </button>
  );

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

  // Alta de lote inline por campo
  const [addingPlotFieldId, setAddingPlotFieldId] = useState<number | null>(null);
  const [newPlotName, setNewPlotName] = useState('');
  const [newPlotHa, setNewPlotHa] = useState('');
  const [newPlotError, setNewPlotError] = useState<string | null>(null);

  const startAddPlot = (fieldId: number) => {
    setAddingPlotFieldId(fieldId);
    setNewPlotName('');
    setNewPlotHa('');
    setNewPlotError(null);
    setEditingPlotId(null);
    setEditingFieldId(null);
  };

  const cancelAddPlot = () => {
    setAddingPlotFieldId(null);
    setNewPlotError(null);
  };

  const createPlot = async (fieldId: number) => {
    const name = newPlotName.trim();
    if (!name) { setNewPlotError('El nombre no puede estar vacío'); return; }
    const haRaw = newPlotHa.trim();
    const hectares = haRaw ? Number(haRaw) : undefined;
    if (hectares !== undefined && (!isFinite(hectares) || hectares <= 0)) {
      setNewPlotError('Hectáreas inválidas'); return;
    }
    setSaving(true);
    setNewPlotError(null);
    try {
      const body: Record<string, unknown> = { name };
      if (hectares !== undefined) body.hectares = hectares;
      await apiRequest(`/fields/${fieldId}/plots`, { method: 'POST', body });
      setAddingPlotFieldId(null);
      await fetchFields();
    } catch (err: unknown) {
      setNewPlotError(err instanceof Error ? err.message : 'Error al crear el lote');
    } finally {
      setSaving(false);
    }
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
      <>
        <TabHeader
          title="Campos"
          description="La estructura de tu establecimiento: campos, lotes, hectáreas y qué hay sembrado. Acá podés renombrar y corregir hectáreas."
          botHint="tengo el campo La Esperanza en Pergamino con los lotes Norte y Sur"
        />
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center text-gray-500 dark:text-gray-400 text-sm mb-4">
          Todavía no tenés campos. Decile al bot{' '}
          <em className="font-medium text-gray-700 dark:text-gray-300">tengo el campo La Esperanza en Pergamino</em>
          {' '}o crealo acá abajo.
        </div>
        {addFieldBlock}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <TabHeader
        title="Campos"
        description="La estructura de tu establecimiento: campos, lotes, hectáreas y qué hay sembrado. Acá podés renombrar y corregir hectáreas."
        botHint="tengo el campo La Esperanza en Pergamino con los lotes Norte y Sur"
      />
      {cityWarning && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          ⚠️ {cityWarning}
        </div>
      )}
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
                      onKeyDown={e => { if (e.key === 'Enter') void saveField(f.id); if (e.key === 'Escape') cancelEditField(); }}
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
                {editingCityFieldId === f.id ? (
                  <div className="mt-1.5 max-w-xs space-y-1">
                    <LocalidadInput
                      value={cityDraft}
                      onChange={setCityDraft}
                      placeholder="Localidad del campo"
                      autoFocus
                      onEnter={() => void saveCity(f.id)}
                      onEscape={() => setEditingCityFieldId(null)}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-2 py-1.5 text-xs focus:ring-2 focus:ring-campo-500 outline-none"
                    />
                    {cityError && <p className="text-xs text-red-600 dark:text-red-400">{cityError}</p>}
                    <div className="flex gap-2">
                      <button onClick={() => void saveCity(f.id)} disabled={saving} className="text-xs bg-campo-600 text-white rounded-md px-3 py-1 disabled:opacity-50 hover:bg-campo-700">Guardar</button>
                      <button onClick={() => setEditingCityFieldId(null)} className="text-xs text-gray-500 dark:text-gray-400">Cancelar</button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs mt-0.5 flex items-center gap-1.5 flex-wrap">
                    {f.city || f.has_coords ? (
                      <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
                        <MapPin className="w-3 h-3 text-campo-600 dark:text-campo-400" />
                        {f.city ?? 'Ubicado por mapa/GPS'}
                        {f.location_method === 'map' && f.city ? ' · dibujado en mapa' : ''}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        ⚠️ Sin ubicación — sin clima ni alertas para este campo
                      </span>
                    )}
                    <button
                      onClick={() => startEditCity(f)}
                      className="text-campo-700 dark:text-campo-400 hover:underline"
                      title="Editar localidad"
                    >
                      {f.city ? 'editar' : 'agregar localidad'}
                    </button>
                    {totalHa > 0 && <span className="text-gray-400">· {totalHa} ha totales</span>}
                  </p>
                )}

                <SenasaFields field={f} onSaved={fetchFields} />
              </div>
            </div>

            {/* Plots */}
            {f.plots.length > 0 && (
              <div className="mt-3 space-y-2 pl-2 border-l-2 border-gray-100 dark:border-gray-700">
                {f.plots.map(p => (
                  <div key={p.id} className="pl-2">
                    {editingPlotId === p.id ? (
                      <div className="space-y-1">
                        <div className="space-y-2 max-w-xs">
                          <div>
                            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Nombre del lote</label>
                            <input
                              value={plotNameDraft}
                              onChange={e => setPlotNameDraft(e.target.value)}
                              placeholder="Ej: Lote Norte"
                              className="w-full text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-2 py-1.5 placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-campo-500 outline-none"
                              autoFocus
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Hectáreas</label>
                            <input
                              type="number"
                              value={plotHaDraft}
                              onChange={e => setPlotHaDraft(e.target.value)}
                              placeholder="Ej: 50"
                              min="0.01"
                              max="100000"
                              step="0.01"
                              className="w-full text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-2 py-1.5 placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-campo-500 outline-none"
                            />
                          </div>
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

            {/* Alta de lote */}
            <div className="mt-3 pl-2">
              {addingPlotFieldId === f.id ? (
                <div className="space-y-1 pl-2 border-l-2 border-campo-200 dark:border-campo-800">
                  <div className="space-y-2 max-w-xs pl-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Nombre del lote</label>
                      <input
                        value={newPlotName}
                        onChange={e => setNewPlotName(e.target.value)}
                        placeholder="Ej: Lote Norte"
                        className="w-full text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-2 py-1.5 placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-campo-500 outline-none"
                        autoFocus
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Hectáreas (opcional)</label>
                      <input
                        type="number"
                        value={newPlotHa}
                        onChange={e => setNewPlotHa(e.target.value)}
                        placeholder="Ej: 50"
                        min="0.01"
                        max="100000"
                        step="0.01"
                        className="w-full text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-2 py-1.5 placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-campo-500 outline-none"
                      />
                    </div>
                    {newPlotError && <p className="text-xs text-red-600 dark:text-red-400">{newPlotError}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={() => void createPlot(f.id)}
                        disabled={saving}
                        className="text-xs bg-campo-600 text-white rounded-md px-3 py-1.5 disabled:opacity-50 hover:bg-campo-700"
                      >
                        Crear lote
                      </button>
                      <button onClick={cancelAddPlot} className="text-xs text-gray-500 dark:text-gray-400">Cancelar</button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => startAddPlot(f.id)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-campo-700 dark:text-campo-400 hover:text-campo-800 dark:hover:text-campo-300"
                >
                  <Plus className="w-3.5 h-3.5" /> Agregar lote
                </button>
              )}
            </div>
          </div>
        );
      })}
      {addFieldBlock}
    </div>
  );
}
