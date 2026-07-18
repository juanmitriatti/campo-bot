import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';

interface Reminder {
  id: number;
  description: string;
  due_date: string;
  due_time: string | null;
  status: 'pending' | 'sent' | 'done' | 'cancelled';
  sent_at: string | null;
  plot_name: string | null;
  field_name: string | null;
}

interface RemindersResponse {
  reminders: Reminder[];
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${day}/${month}/${year.slice(-2)}`;
}

function isOverdue(reminder: Reminder): boolean {
  if (!['pending', 'sent'].includes(reminder.status)) return false;
  const today = new Date().toISOString().slice(0, 10);
  return reminder.due_date < today;
}

function StatusBadge({ status }: { status: Reminder['status'] }) {
  const configs: Record<Reminder['status'], { label: string; cls: string }> = {
    pending: { label: 'pendiente', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
    sent:    { label: 'avisado',   cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
    done:    { label: 'hecho',     cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' },
    cancelled: { label: 'cancelado', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400' },
  };
  const { label, cls } = configs[status] ?? configs.pending;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

export default function RemindersTab() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Per-reminder cancel confirm state
  const [confirmingCancel, setConfirmingCancel] = useState<number | null>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);

  const fetchReminders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<RemindersResponse>('/reminders?status=all');
      setReminders(result.reminders);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar recordatorios');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchReminders(); }, [fetchReminders]);

  const doAction = async (id: number, action: 'done' | 'cancel') => {
    setActionBusy(id);
    setConfirmingCancel(null);
    try {
      await apiRequest(`/reminders/${id}`, {
        method: 'PATCH',
        body: { action },
      });
      await fetchReminders();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'No pude actualizar el recordatorio.');
    } finally {
      setActionBusy(null);
    }
  };

  const pending = reminders.filter(r => r.status === 'pending' || r.status === 'sent');
  const history = reminders.filter(r => r.status === 'done' || r.status === 'cancelled');

  if (loading) {
    return <div className="p-6 text-gray-500 dark:text-gray-300">Cargando recordatorios…</div>;
  }

  if (error) {
    return (
      <div className="p-6">
        <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
        <button onClick={fetchReminders} className="mt-2 text-sm text-campo-600 hover:underline">
          Reintentar
        </button>
      </div>
    );
  }

  if (reminders.length === 0 && !loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">Recordatorios</h2>
          <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">
            Tus recordatorios de labores y tareas del campo.
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-10 text-center">
          <p className="text-gray-500 dark:text-gray-400 text-sm">No tenés recordatorios.</p>
          <p className="text-gray-400 dark:text-gray-500 text-xs mt-2">
            Pedímelos por chat: <em>acordame el sábado a las 9 de fumigar el lote 5</em>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">Recordatorios</h2>
        <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">
          Tus recordatorios de labores y tareas del campo.
        </p>
      </div>

      {/* Pendientes */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <h3 className="font-semibold text-gray-800 dark:text-gray-100">
            Pendientes
            {pending.length > 0 && (
              <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">({pending.length})</span>
            )}
          </h3>
        </div>

        {pending.length === 0 ? (
          <div className="px-6 py-8 text-center">
            <p className="text-gray-500 dark:text-gray-400 text-sm">No tenés recordatorios pendientes.</p>
            <p className="text-gray-400 dark:text-gray-500 text-xs mt-2">
              Pedímelos por chat: <em>acordame el sábado a las 9 de fumigar el lote 5</em>
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {pending.map(r => (
              <li key={r.id} className="px-6 py-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                      {isOverdue(r) && <span className="mr-1">⚠️ vencido —</span>}
                      {r.description}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {formatDate(r.due_date)}
                        {r.due_time && <span> a las {r.due_time}</span>}
                      </span>
                      {(r.field_name || r.plot_name) && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                          {r.plot_name ?? r.field_name}
                        </span>
                      )}
                      <StatusBadge status={r.status} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {confirmingCancel === r.id ? (
                      <>
                        <span className="text-xs text-gray-500 dark:text-gray-400">¿Seguro?</span>
                        <button
                          onClick={() => doAction(r.id, 'cancel')}
                          disabled={actionBusy === r.id}
                          className="text-xs px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 disabled:opacity-50"
                        >
                          Sí, cancelar
                        </button>
                        <button
                          onClick={() => setConfirmingCancel(null)}
                          className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300"
                        >
                          No
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => doAction(r.id, 'done')}
                          disabled={actionBusy === r.id}
                          className="text-xs px-2.5 py-1 rounded bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 disabled:opacity-50 font-medium"
                        >
                          ✓ Hecho
                        </button>
                        <button
                          onClick={() => setConfirmingCancel(r.id)}
                          disabled={actionBusy === r.id}
                          className="text-xs px-2.5 py-1 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 disabled:opacity-50"
                        >
                          ✕ Cancelar
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Historial (colapsable) */}
      {history.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
          <button
            className="w-full px-6 py-4 flex items-center justify-between text-left"
            onClick={() => setHistoryOpen(o => !o)}
          >
            <span className="font-semibold text-gray-800 dark:text-gray-100">
              Historial
              <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">({history.length})</span>
            </span>
            <span className="text-gray-400 dark:text-gray-500 text-sm">{historyOpen ? '▲' : '▼'}</span>
          </button>
          {historyOpen && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700 border-t border-gray-100 dark:border-gray-700">
              {history.map(r => (
                <li key={r.id} className="px-6 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-gray-700 dark:text-gray-300 flex-1 min-w-0 truncate">{r.description}</p>
                    <span className="text-xs text-gray-400 dark:text-gray-500">{formatDate(r.due_date)}</span>
                    {(r.field_name || r.plot_name) && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                        {r.plot_name ?? r.field_name}
                      </span>
                    )}
                    <StatusBadge status={r.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

    </div>
  );
}
