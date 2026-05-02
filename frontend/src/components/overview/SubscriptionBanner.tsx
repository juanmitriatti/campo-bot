import { useEffect, useState } from 'react';
import { apiRequest } from '../../api/client';

interface SubscriptionRow {
  status: 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired';
  trial_ends_at: string | null;
  current_period_end: string | null;
}

interface SubscriptionStatus {
  subscription: SubscriptionRow | null;
  plan: { display_name: string } | null;
  payments_enabled: boolean;
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export default function SubscriptionBanner({ onGoToAccount }: { onGoToAccount: () => void }) {
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);

  useEffect(() => {
    apiRequest<SubscriptionStatus>('/subscription')
      .then(setSub)
      .catch(() => setSub(null));
  }, []);

  if (!sub?.payments_enabled || !sub.subscription) return null;
  const { status, trial_ends_at, current_period_end } = sub.subscription;

  if (status === 'trial' && trial_ends_at) {
    const days = daysUntil(trial_ends_at);
    if (days < 0) return null;
    const tone = days <= 3 ? 'amber' : 'blue';
    const colors = tone === 'amber'
      ? 'bg-amber-50 border-amber-200 text-amber-900'
      : 'bg-blue-50 border-blue-200 text-blue-900';
    return (
      <div className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${colors}`}>
        <div className="flex items-center gap-2">
          <span>⏳</span>
          <span>
            <strong>Trial gratis</strong> — quedan <strong>{days} día{days === 1 ? '' : 's'}</strong>.
            {sub.plan ? ` Después pasás a ${sub.plan.display_name}.` : ''}
          </span>
        </div>
        <button
          onClick={onGoToAccount}
          className="text-sm font-medium underline hover:no-underline"
        >
          Activar pago
        </button>
      </div>
    );
  }

  if (status === 'past_due') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <div className="flex items-center gap-2">
          <span>⚠️</span>
          <span>
            <strong>Pago pendiente</strong> — tu suscripción está en revisión. Actualizá el método de pago para no perder acceso.
          </span>
        </div>
        <button
          onClick={onGoToAccount}
          className="text-sm font-medium underline hover:no-underline"
        >
          Resolver
        </button>
      </div>
    );
  }

  if (status === 'cancelled' && current_period_end) {
    const days = daysUntil(current_period_end);
    if (days < 0) return null;
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-700">
        <div className="flex items-center gap-2">
          <span>🛑</span>
          <span>
            Suscripción cancelada — acceso hasta el {new Date(current_period_end).toLocaleDateString('es-AR')} ({days} día{days === 1 ? '' : 's'}).
          </span>
        </div>
        <button
          onClick={onGoToAccount}
          className="text-sm font-medium underline hover:no-underline"
        >
          Reactivar
        </button>
      </div>
    );
  }

  if (status === 'expired') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
        <div className="flex items-center gap-2">
          <span>🚫</span>
          <span><strong>Suscripción vencida</strong> — algunas funciones quedaron limitadas.</span>
        </div>
        <button
          onClick={onGoToAccount}
          className="text-sm font-medium underline hover:no-underline"
        >
          Renovar
        </button>
      </div>
    );
  }

  return null;
}
