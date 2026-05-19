import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';

interface StockItem {
  id: number;
  name: string;
  current_quantity: number;
  unit: string;
}

interface Movement {
  id: number;
  movement_type: string;
  quantity: number;
  reason: string | null;
  notes: string | null;
  movement_date: string;
  created_at: string;
}

interface Props {
  item: StockItem;
  onClose: () => void;
}

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  entrada: { label: 'Entrada', color: 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300' },
  salida: { label: 'Salida', color: 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300' },
  ajuste: { label: 'Ajuste', color: 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300' },
};

export default function StockMovementHistory({ item, onClose }: Props) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiRequest<{ item: StockItem; movements: Movement[] }>(`/stock/${item.id}/movements`)
      .then(r => setMovements(r.movements))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [item.id]);

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Movimientos de {item.name}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-300">Stock actual: {item.current_quantity} {item.unit}</p>
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
                const typeInfo = TYPE_LABELS[m.movement_type] || { label: m.movement_type, color: 'bg-gray-100 text-gray-800' };
                const sign = m.movement_type === 'salida' ? '-' : m.movement_type === 'entrada' ? '+' : '=';
                return (
                  <div key={m.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-md">
                    <div className="flex items-center gap-3">
                      <span className={`inline-block text-xs px-2 py-0.5 rounded ${typeInfo.color}`}>
                        {typeInfo.label}
                      </span>
                      <div>
                        <p className="text-sm text-gray-800 dark:text-gray-100">{sign}{m.quantity} {item.unit}</p>
                        {m.reason && <p className="text-xs text-gray-500 dark:text-gray-300">{m.reason}</p>}
                      </div>
                    </div>
                    <span className="text-xs text-gray-400 dark:text-gray-300">{formatDate(m.movement_date)}</span>
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
