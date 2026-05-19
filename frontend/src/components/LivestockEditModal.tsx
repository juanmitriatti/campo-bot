import { useState } from 'react';
import { apiRequest } from '../api/client';

interface LivestockGroup {
  id: string;
  category: string;
  breed: string | null;
  count: number;
  avg_weight_kg: number | null;
  notes: string | null;
}

interface Props {
  group: LivestockGroup;
  onClose: () => void;
  onSaved: () => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  vaca: 'Vaca', vaquillona: 'Vaquillona', ternero: 'Ternero', ternera: 'Ternera',
  novillo: 'Novillo', novillito: 'Novillito', toro: 'Toro', torito: 'Torito', buey: 'Buey',
};

export default function LivestockEditModal({ group, onClose, onSaved }: Props) {
  const [breed, setBreed] = useState(group.breed ?? '');
  const [avgWeight, setAvgWeight] = useState(group.avg_weight_kg != null ? String(group.avg_weight_kg) : '');
  const [notes, setNotes] = useState(group.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/livestock/${group.id}`, {
        method: 'PATCH',
        body: {
          breed: breed.trim() || null,
          avg_weight_kg: avgWeight ? parseFloat(avgWeight) : null,
          notes: notes.trim() || null,
        },
      });
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const categoryLabel = CATEGORY_LABELS[group.category] || group.category;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Editar grupo · {categoryLabel}</h3>
            <button onClick={onClose} className="text-gray-400 dark:text-gray-300 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-300 mb-4">
            Cantidad actual: <strong>{group.count} animales</strong>.
            Para cambiar la cantidad usá los comandos del bot (agregué/vendí/transferí/etc).
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-300 mb-1">Raza</label>
              <input type="text" value={breed} onChange={e => setBreed(e.target.value)}
                placeholder="Ej: Angus, Hereford..."
                className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-300 mb-1">Peso promedio (kg)</label>
              <input type="number" step="0.1" value={avgWeight} onChange={e => setAvgWeight(e.target.value)}
                placeholder="Sin promedio"
                className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-300 mb-1">Notas</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
                placeholder="Observaciones del grupo..."
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none resize-none dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600" />
            </div>
          </div>

          {error && <p className="text-red-600 text-sm mt-2">{error}</p>}

          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancelar
            </button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 text-sm text-white bg-campo-600 hover:bg-campo-700 rounded-md disabled:opacity-50">
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
