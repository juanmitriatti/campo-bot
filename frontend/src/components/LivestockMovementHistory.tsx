import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';

interface LivestockGroup {
  id: string;
  category: string;
  breed: string | null;
  count: number;
  field_name: string;
  plot_name: string | null;
}

interface Movement {
  id: string;
  movement_type: string;
  source_group_id: string | null;
  dest_group_id: string | null;
  count: number;
  avg_weight_kg: number | null;
  unit_price_ars: number | null;
  unit_price_usd: number | null;
  reason: string | null;
  notes: string | null;
  movement_date: string;
  created_at: string;
}

interface Props {
  group: LivestockGroup;
  onClose: () => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  vaca: 'Vaca', vaquillona: 'Vaquillona', ternero: 'Ternero', ternera: 'Ternera',
  novillo: 'Novillo', novillito: 'Novillito', toro: 'Toro', torito: 'Torito', buey: 'Buey',
};

const TYPE_LABELS: Record<string, { emoji: string; label: string; color: string }> = {
  entrada: { emoji: '📥', label: 'Entrada', color: 'bg-green-100 text-green-800' },
  salida: { emoji: '📤', label: 'Salida', color: 'bg-red-100 text-red-800' },
  transferencia: { emoji: '🔄', label: 'Transferencia', color: 'bg-blue-100 text-blue-800' },
  muerte: { emoji: '💀', label: 'Muerte', color: 'bg-gray-200 text-gray-800' },
  nacimiento: { emoji: '🐣', label: 'Nacimiento', color: 'bg-yellow-100 text-yellow-800' },
  recategorizacion: { emoji: '🔁', label: 'Recategorización', color: 'bg-purple-100 text-purple-800' },
  ajuste: { emoji: '📊', label: 'Ajuste', color: 'bg-indigo-100 text-indigo-800' },
};

export default function LivestockMovementHistory({ group, onClose }: Props) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiRequest<{ group: LivestockGroup; movements: Movement[] }>(`/livestock/${group.id}/movements`)
      .then(r => setMovements(r.movements))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [group.id]);

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const categoryLabel = CATEGORY_LABELS[group.category] || group.category;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-800">
                Movimientos · {categoryLabel}
              </h3>
              <p className="text-sm text-gray-500">
                {group.plot_name} · {group.field_name} · {group.count} animales
                {group.breed && ` · ${group.breed}`}
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
          </div>

          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-campo-600" />
            </div>
          ) : movements.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No hay movimientos registrados</p>
          ) : (
            <div className="space-y-2">
              {movements.map(m => {
                const typeInfo = TYPE_LABELS[m.movement_type] || { emoji: '•', label: m.movement_type, color: 'bg-gray-100 text-gray-800' };
                const isOutgoing = m.source_group_id === group.id && m.dest_group_id !== group.id;
                const isIncoming = m.dest_group_id === group.id && m.source_group_id !== group.id;
                const sign = isOutgoing ? '-' : isIncoming ? '+' : '';
                return (
                  <div key={m.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
                    <div className="flex items-center gap-3">
                      <span className={`inline-block text-xs px-2 py-0.5 rounded ${typeInfo.color}`}>
                        {typeInfo.emoji} {typeInfo.label}
                      </span>
                      <div>
                        <p className="text-sm text-gray-800">{sign}{m.count} animales</p>
                        {m.avg_weight_kg != null && (
                          <p className="text-xs text-gray-500">~{m.avg_weight_kg} kg/cabeza</p>
                        )}
                        {(m.unit_price_ars != null || m.unit_price_usd != null) && (
                          <p className="text-xs text-gray-500">
                            {m.unit_price_ars != null && `$${m.unit_price_ars.toLocaleString('es-AR')} ARS`}
                            {m.unit_price_usd != null && ` US$${m.unit_price_usd.toLocaleString('es-AR')}`}
                          </p>
                        )}
                        {m.reason && <p className="text-xs text-gray-500">{m.reason}</p>}
                        {m.notes && <p className="text-xs text-gray-400 italic">{m.notes}</p>}
                      </div>
                    </div>
                    <span className="text-xs text-gray-400 whitespace-nowrap">{formatDate(m.movement_date)}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex justify-end mt-4">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50">
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
