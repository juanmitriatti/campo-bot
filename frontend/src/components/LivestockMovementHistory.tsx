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

import {
  ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight, Skull, Egg,
  Repeat, BarChart3,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const TYPE_LABELS: Record<string, { Icon: LucideIcon; label: string; color: string }> = {
  entrada: { Icon: ArrowDownToLine, label: 'Entrada', color: 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300' },
  salida: { Icon: ArrowUpFromLine, label: 'Salida', color: 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300' },
  transferencia: { Icon: ArrowLeftRight, label: 'Transferencia', color: 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300' },
  muerte: { Icon: Skull, label: 'Muerte', color: 'bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200' },
  nacimiento: { Icon: Egg, label: 'Nacimiento', color: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300' },
  recategorizacion: { Icon: Repeat, label: 'Recategorización', color: 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300' },
  ajuste: { Icon: BarChart3, label: 'Ajuste', color: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-300' },
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
                Movimientos · {categoryLabel}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-300">
                {group.plot_name} · {group.field_name} · {group.count} animales
                {group.breed && ` · ${group.breed}`}
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 dark:text-gray-300 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
          </div>

          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-campo-600" />
            </div>
          ) : movements.length === 0 ? (
            <p className="text-center text-gray-500 dark:text-gray-300 py-8">No hay movimientos registrados</p>
          ) : (
            <div className="space-y-2">
              {movements.map(m => {
                const typeInfo = TYPE_LABELS[m.movement_type];
                const TypeIcon = typeInfo?.Icon;
                const typeLabel = typeInfo?.label ?? m.movement_type;
                const typeColor = typeInfo?.color ?? 'bg-gray-100 text-gray-800';
                const isOutgoing = m.source_group_id === group.id && m.dest_group_id !== group.id;
                const isIncoming = m.dest_group_id === group.id && m.source_group_id !== group.id;
                const sign = isOutgoing ? '-' : isIncoming ? '+' : '';
                return (
                  <div key={m.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-md">
                    <div className="flex items-center gap-3">
                      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${typeColor}`}>
                        {TypeIcon && <TypeIcon className="w-3.5 h-3.5" />}
                        {typeLabel}
                      </span>
                      <div>
                        <p className="text-sm text-gray-800 dark:text-gray-100">{sign}{m.count} animales</p>
                        {m.avg_weight_kg != null && (
                          <p className="text-xs text-gray-500 dark:text-gray-300">~{m.avg_weight_kg} kg/cabeza</p>
                        )}
                        {(m.unit_price_ars != null || m.unit_price_usd != null) && (
                          <p className="text-xs text-gray-500 dark:text-gray-300">
                            {m.unit_price_ars != null && `$${m.unit_price_ars.toLocaleString('es-AR')} ARS`}
                            {m.unit_price_usd != null && ` US$${m.unit_price_usd.toLocaleString('es-AR')}`}
                          </p>
                        )}
                        {m.reason && <p className="text-xs text-gray-500 dark:text-gray-300">{m.reason}</p>}
                        {m.notes && <p className="text-xs text-gray-400 dark:text-gray-300 italic">{m.notes}</p>}
                      </div>
                    </div>
                    <span className="text-xs text-gray-400 dark:text-gray-300 whitespace-nowrap">{formatDate(m.movement_date)}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex justify-end mt-4">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700">
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
