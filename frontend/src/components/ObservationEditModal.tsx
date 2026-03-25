import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';

interface Observation {
  id: number;
  observation_text: string;
  category: string;
  created_at: string;
  updated_at: string | null;
  plot_name: string | null;
  field_name: string | null;
}

interface HistoryEntry {
  id: number;
  previous_text: string;
  new_text: string;
  previous_category: string | null;
  new_category: string | null;
  edited_by: number;
  edited_at: string;
}

interface Props {
  observation: Observation;
  onClose: () => void;
  onSaved: () => void;
}

export default function ObservationEditModal({ observation, onClose, onSaved }: Props) {
  const [text, setText] = useState(observation.observation_text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    apiRequest<{ history: HistoryEntry[] }>(`/observations/${observation.id}/history`)
      .then(data => setHistory(data.history))
      .catch(() => {})
      .finally(() => setLoadingHistory(false));
  }, [observation.id]);

  const handleSave = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError('El texto no puede estar vacío');
      return;
    }
    if (trimmed === observation.observation_text) {
      onClose();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/observations/${observation.id}`, {
        method: 'PATCH',
        body: { text: trimmed },
      });
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800">Editar observación</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
          </div>

          {/* Metadata */}
          <div className="text-sm text-gray-500 mb-3 space-y-1">
            {observation.field_name && <p>Campo: <span className="font-medium text-gray-700">{observation.field_name}</span></p>}
            {observation.plot_name && <p>Lote: <span className="font-medium text-gray-700">{observation.plot_name}</span></p>}
            <p>Categoría: <span className="font-medium text-gray-700">{observation.category}</span></p>
          </div>

          {/* Edit area */}
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={4}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none resize-none"
            placeholder="Texto de la observación..."
          />

          {error && <p className="text-red-600 text-sm mt-2">{error}</p>}

          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm text-white bg-campo-600 hover:bg-campo-700 rounded-md disabled:opacity-50 transition-colors"
            >
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>

        {/* History section */}
        {!loadingHistory && history.length > 0 && (
          <div className="border-t border-gray-200">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="w-full px-6 py-3 text-left text-sm text-gray-600 hover:bg-gray-50 flex items-center justify-between"
            >
              <span>Historial de ediciones ({history.length})</span>
              <span className="text-xs">{showHistory ? '▲' : '▼'}</span>
            </button>

            {showHistory && (
              <div className="px-6 pb-4 space-y-3">
                {history.map(h => (
                  <div key={h.id} className="text-sm border-l-2 border-campo-300 pl-3">
                    <p className="text-gray-400 text-xs">
                      {new Date(h.edited_at).toLocaleString('es-AR')}
                    </p>
                    <p className="text-red-500 line-through">{h.previous_text}</p>
                    <p className="text-campo-700">{h.new_text}</p>
                    {h.previous_category !== h.new_category && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        Categoría: {h.previous_category} → {h.new_category}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
