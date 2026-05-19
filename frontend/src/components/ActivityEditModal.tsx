import { useState, useEffect } from 'react';
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
  pregnant_count: number | null;
  open_count: number | null;
  uncertain_count: number | null;
  field_name: string | null;
  plot_name: string | null;
  plot_id?: number | null;
  field_id?: number | null;
}

interface Props {
  activity: Activity;
  onClose: () => void;
  onSaved: () => void;
}

interface PlotOption { id: number; name: string }
interface FieldOption { id: number; name: string; plots: PlotOption[] }

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
  { id: 'tacto', label: 'Tacto' },
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
  const [pregnantCount, setPregnantCount] = useState(activity.pregnant_count != null ? String(activity.pregnant_count) : '');
  const [openCountVal, setOpenCountVal] = useState(activity.open_count != null ? String(activity.open_count) : '');
  const [uncertainCount, setUncertainCount] = useState(activity.uncertain_count != null ? String(activity.uncertain_count) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Field/plot selection
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<number | ''>('');
  const [selectedPlotId, setSelectedPlotId] = useState<number | ''>('');
  const [loadingFields, setLoadingFields] = useState(true);

  useEffect(() => {
    apiRequest<{ fields: FieldOption[] }>('/observations/filters')
      .then(data => {
        setFields(data.fields);
        // Pre-select current field/plot
        if (activity.plot_id) {
          for (const f of data.fields) {
            const p = f.plots.find(pl => pl.id === activity.plot_id);
            if (p) {
              setSelectedFieldId(f.id);
              setSelectedPlotId(p.id);
              break;
            }
          }
        } else if (activity.field_name) {
          const f = data.fields.find(fl => fl.name === activity.field_name);
          if (f) setSelectedFieldId(f.id);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingFields(false));
  }, [activity.plot_id, activity.field_name]);

  const selectedField = fields.find(f => f.id === selectedFieldId);
  const availablePlots = selectedField?.plots || [];

  const handleFieldChange = (fid: number | '') => {
    setSelectedFieldId(fid);
    setSelectedPlotId('');
  };

  const handleSave = async () => {
    if (!eventType) { setError('El tipo es obligatorio'); return; }

    const parsedQty = quantity.trim() ? parseFloat(quantity) : null;

    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        event_type: eventType,
        event_date: eventDate,
        crop: crop.trim() || null,
        product: product.trim() || null,
        quantity: parsedQty,
        unit: unit.trim() || null,
        implement: implement.trim() || null,
        notes: notes.trim() || null,
      };
      if (eventType === 'tacto') {
        body.pregnant_count = pregnantCount.trim() ? parseInt(pregnantCount) : null;
        body.open_count = openCountVal.trim() ? parseInt(openCountVal) : null;
        body.uncertain_count = uncertainCount.trim() ? parseInt(uncertainCount) : null;
      }
      // Include plot_id if changed
      if (selectedPlotId !== '' && selectedPlotId !== activity.plot_id) {
        body.plot_id = selectedPlotId;
      }
      await apiRequest(`/activities/${activity.id}`, {
        method: 'PATCH',
        body,
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Editar actividad</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">&times;</button>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Campo</label>
              {loadingFields ? (
                <p className="text-sm text-gray-400 dark:text-gray-500">Cargando...</p>
              ) : (
                <select
                  value={selectedFieldId}
                  onChange={e => handleFieldChange(e.target.value ? Number(e.target.value) : '')}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                >
                  <option value="">Sin campo</option>
                  {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              )}
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Lote</label>
              <select
                value={selectedPlotId}
                onChange={e => setSelectedPlotId(e.target.value ? Number(e.target.value) : '')}
                className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                disabled={!selectedFieldId || availablePlots.length === 0}
              >
                <option value="">Sin lote</option>
                {availablePlots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Tipo</label>
                <select value={eventType} onChange={e => setEventType(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none">
                  {ACTIVITY_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Fecha</label>
                <input type="date" value={eventDate} onChange={e => setEventDate(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Cultivo</label>
                <input type="text" value={crop} onChange={e => setCrop(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: Soja" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Producto</label>
                <input type="text" value={product} onChange={e => setProduct(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: Glifosato" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Cantidad</label>
                <input type="number" step="0.01" value={quantity} onChange={e => setQuantity(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: 2.5" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Unidad</label>
                <input type="text" value={unit} onChange={e => setUnit(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                  placeholder="Ej: lt/ha" />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Implemento</label>
              <input type="text" value={implement} onChange={e => setImplement(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                placeholder="Ej: Pulverizadora" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Notas</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none resize-none"
                placeholder="Notas adicionales..." />
            </div>
            {eventType === 'tacto' && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Preñadas</label>
                  <input type="number" value={pregnantCount} onChange={e => setPregnantCount(e.target.value)}
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                    placeholder="0" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Vacías</label>
                  <input type="number" value={openCountVal} onChange={e => setOpenCountVal(e.target.value)}
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                    placeholder="0" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Dudosas</label>
                  <input type="number" value={uncertainCount} onChange={e => setUncertainCount(e.target.value)}
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
                    placeholder="0" />
                </div>
              </div>
            )}
          </div>

          {error && <p className="text-red-600 text-sm mt-2">{error}</p>}

          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
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
