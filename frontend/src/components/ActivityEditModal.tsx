import { useState } from 'react';
import { apiRequest } from '../api/client';

interface Activity {
  id: number;
  event_type: string;
  event_date: string;
  crop: string | null;
  product: string | null;
  quantity: number | null;
  unit: string | null;
  implement: string | null;
  notes: string | null;
  field_name: string | null;
  plot_name: string | null;
}

interface Props {
  activity: Activity;
  onClose: () => void;
  onSaved: () => void;
}

function toLocalDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ACTIVITY_TYPES = [
  { id: 'spraying', label: 'Fumigacion' },
  { id: 'fertilization', label: 'Fertilizacion' },
  { id: 'planting', label: 'Siembra' },
  { id: 'tillage', label: 'Labranza' },
  { id: 'harvest', label: 'Cosecha' },
  { id: 'irrigation', label: 'Riego' },
];

export default function ActivityEditModal({ activity, onClose, onSaved }: Props) {
  const [eventType, setEventType] = useState(activity.event_type);
  const [eventDate, setEventDate] = useState(activity.event_date ? toLocalDate(activity.event_date) : '');
  const [crop, setCrop] = useState(activity.crop || '');
  const [product, setProduct] = useState(activity.product || '');
  const [quantity, setQuantity] = useState(activity.quantity != null ? String(activity.quantity) : '');
  const [unit, setUnit] = useState(activity.unit || '');
  const [implement, setImplement] = useState(activity.implement || '');
  const [notes, setNotes] = useState(activity.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!eventType) { setError('El tipo es obligatorio'); return; }

    const parsedQty = quantity.trim() ? parseFloat(quantity) : null;

    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/activities/${activity.id}`, {
        method: 'PATCH',
        body: {
          event_type: eventType,
          event_date: eventDate,
          crop: crop.trim() || null,
          product: product.trim() || null,
          quantity: parsedQty,
          unit: unit.trim() || null,
          implement: implement.trim() || null,
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

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800">Editar actividad</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
          </div>

          {activity.field_name && <p className="text-sm text-gray-500 mb-1">Campo: <span className="font-medium text-gray-700">{activity.field_name}</span></p>}
          {activity.plot_name && <p className="text-sm text-gray-500 mb-3">Lote: <span className="font-medium text-gray-700">{activity.plot_name}</span></p>}

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Tipo</label>
                <select value={eventType} onChange={e => setEventType(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none">
                  {ACTIVITY_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Fecha</label>
                <input type="date" value={eventDate} onChange={e => setEventDate(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Cultivo</label>
                <input type="text" value={crop} onChange={e => setCrop(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: Soja" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Producto</label>
                <input type="text" value={product} onChange={e => setProduct(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: Glifosato" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Cantidad</label>
                <input type="number" step="0.01" value={quantity} onChange={e => setQuantity(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: 2.5" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Unidad</label>
                <input type="text" value={unit} onChange={e => setUnit(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: lt/ha" />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Implemento</label>
              <input type="text" value={implement} onChange={e => setImplement(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                placeholder="Ej: Pulverizadora" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Notas</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none resize-none"
                placeholder="Notas adicionales..." />
            </div>
          </div>

          {error && <p className="text-red-600 text-sm mt-2">{error}</p>}

          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
              Cancelar
            </button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 text-sm text-white bg-campo-600 hover:bg-campo-700 rounded-md disabled:opacity-50 transition-colors">
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
