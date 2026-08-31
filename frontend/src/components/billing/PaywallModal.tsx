import { useState } from 'react';
import { ApiError } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import type { SubscriptionStatus } from '../../api/subscription';
import { startCheckout } from '../../api/subscription';
import PlanChooser from './PlanChooser';

/**
 * Paywall de prueba vencida.
 *
 * Se levanta cuando el access-gate del backend dice `trial_expired_readonly`,
 * el MISMO gate que ya corta el bot: antes el dashboard no lo miraba, así que
 * el bot le decía "activá tu plan desde tu panel" y el panel lo dejaba entrar
 * como si nada — y encima sin botón de pago, porque `/subscription` no
 * devolvía las suscripciones vencidas.
 *
 * No se puede cerrar a propósito: el board queda borroso atrás. Lo único que
 * sigue disponible es salir de la sesión y el link para exportar/eliminar los
 * datos — el acceso a los propios datos no se cobra (GDPR, y además es lo que
 * el mensaje del bot promete: "tus datos siguen guardados").
 */

interface Props {
  status: SubscriptionStatus;
  /** Abre "Mi cuenta", donde viven exportar datos y eliminar cuenta. */
  onGoToAccount: () => void;
}

export default function PaywallModal({ status, onGoToAccount }: Props) {
  const { logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheckout = async (plan: string, period: 'monthly' | 'yearly') => {
    setError(null);
    setBusy(true);
    try {
      window.location.href = await startCheckout(plan, period);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No pude iniciar el pago. Probá de nuevo en un momento.');
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-gray-900/60 backdrop-blur-[2px] p-4 py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paywall-title"
    >
      <div className="w-full max-w-3xl rounded-2xl bg-white dark:bg-gray-800 shadow-2xl border border-gray-200 dark:border-gray-700">
        <div className="rounded-t-2xl bg-gradient-to-r from-campo-600 to-campo-800 px-6 py-5 text-white">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-xl">⏳</div>
            <div>
              <h2 id="paywall-title" className="text-lg font-semibold leading-tight">Tu prueba terminó</h2>
              <p className="text-sm text-campo-100">
                Elegí un plan para seguir usando el bot y el panel.
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-5">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Tus datos siguen guardados — no se borró nada. Cuando actives un plan, todo vuelve
            a estar donde lo dejaste, en el panel y en WhatsApp o Telegram.
          </p>

          {/* Sin `currentPlanName`: el plan de la prueba ya no es "su plan" —
              marcarlo acá le diría "tu plan" a algo que perdió. */}
          <PlanChooser
            plans={status.plans}
            supportContact={status.support_contact}
            busy={busy}
            onCheckout={handleCheckout}
          />

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 dark:border-gray-700 pt-4 text-xs">
            <button
              type="button"
              onClick={onGoToAccount}
              className="text-gray-500 dark:text-gray-400 underline hover:text-gray-800 dark:hover:text-gray-100 transition-colors"
            >
              Exportar o eliminar mis datos
            </button>
            <button
              type="button"
              onClick={logout}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              Cerrar sesión
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
