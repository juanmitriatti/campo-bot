import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiRequest, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';

interface VerificationStatus {
  whatsapp_verified: boolean;
  telegram_verified: boolean;
  phone_number: string | null;
  telegram_id: string | null;
}

interface SubscriptionRow {
  id: number;
  status: 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired';
  billing_period: 'monthly' | 'yearly';
  trial_ends_at: string | null;
  current_period_end: string | null;
  provider: string;
}

interface SubscriptionStatus {
  subscription: SubscriptionRow | null;
  plan: {
    id: number;
    name: string;
    display_name: string;
    price_ars: number;
    price_ars_yearly: number | null;
  } | null;
  payments_enabled: boolean;
}

type WaStep = 'idle' | 'enter-phone' | 'enter-code' | 'success';

export default function ChannelLinking() {
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // WhatsApp flow state
  const [waStep, setWaStep] = useState<WaStep>('idle');
  const [waPhone, setWaPhone] = useState('');
  const [waCode, setWaCode] = useState('');
  const [waExpiresAt, setWaExpiresAt] = useState<string | null>(null);
  const [waBusy, setWaBusy] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);

  // Telegram flow state
  const [tgLink, setTgLink] = useState<string | null>(null);
  const [tgBusy, setTgBusy] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);

  // Export + delete state
  const [exportBusy, setExportBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Subscription state
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>('monthly');

  const { logout } = useAuth();
  const navigate = useNavigate();

  const refreshStatus = async () => {
    try {
      const s = await apiRequest<VerificationStatus>('/verify/status');
      setStatus(s);
    } catch {
      // ignore
    }
  };

  const refreshSub = async () => {
    try {
      const s = await apiRequest<SubscriptionStatus>('/subscription');
      setSub(s);
    } catch {
      // ignore (e.g. payments_enabled=false → endpoint still returns)
    }
  };

  useEffect(() => {
    Promise.all([refreshStatus(), refreshSub()]).finally(() => setLoading(false));
  }, []);

  // ---------- Subscription ----------
  const upgradeNow = async (planName: string) => {
    setSubError(null);
    setSubBusy(true);
    try {
      const r = await apiRequest<{ init_point: string }>('/subscription/checkout', {
        method: 'POST',
        body: { plan: planName, period: billingPeriod },
      });
      window.location.href = r.init_point;
    } catch (err) {
      setSubError(err instanceof ApiError ? err.message : 'No pude iniciar el checkout.');
      setSubBusy(false);
    }
  };

  const cancelSub = async () => {
    if (!confirm('¿Cancelar la suscripción? Vas a tener acceso hasta el fin del período pagado.')) return;
    setSubBusy(true);
    try {
      await apiRequest('/subscription/cancel', { method: 'POST' });
      await refreshSub();
    } catch (err) {
      setSubError(err instanceof ApiError ? err.message : 'No pude cancelar.');
    } finally {
      setSubBusy(false);
    }
  };

  // ---------- WhatsApp ----------
  const startWhatsApp = async () => {
    setWaError(null);
    if (!waPhone.trim()) {
      setWaError('Ingresá tu número de WhatsApp.');
      return;
    }
    setWaBusy(true);
    try {
      const r = await apiRequest<{ expires_at: string; ttl_minutes: number }>(
        '/verify/whatsapp/start',
        { method: 'POST', body: { phone: waPhone.trim() } },
      );
      setWaExpiresAt(r.expires_at);
      setWaStep('enter-code');
    } catch (err) {
      setWaError(err instanceof ApiError ? err.message : 'No pude iniciar la verificación.');
    } finally {
      setWaBusy(false);
    }
  };

  const confirmWhatsApp = async () => {
    setWaError(null);
    if (!/^\d{6}$/.test(waCode.trim())) {
      setWaError('El código tiene que ser de 6 dígitos.');
      return;
    }
    setWaBusy(true);
    try {
      const s = await apiRequest<VerificationStatus>(
        '/verify/whatsapp/confirm',
        { method: 'POST', body: { code: waCode.trim() } },
      );
      setStatus(s);
      setWaStep('success');
      setWaCode('');
      setTimeout(() => setWaStep('idle'), 2500);
    } catch (err) {
      setWaError(err instanceof ApiError ? err.message : 'No pude confirmar el código.');
    } finally {
      setWaBusy(false);
    }
  };

  const unlinkWhatsApp = async () => {
    if (!confirm('¿Seguro que querés desvincular WhatsApp? Vas a tener que verificar de nuevo si querés volver a usar el bot.')) return;
    setWaBusy(true);
    try {
      const s = await apiRequest<VerificationStatus>('/verify/whatsapp', { method: 'DELETE' });
      setStatus(s);
      setWaStep('idle');
      setWaPhone('');
    } catch (err) {
      setWaError(err instanceof ApiError ? err.message : 'No pude desvincular.');
    } finally {
      setWaBusy(false);
    }
  };

  // ---------- Telegram ----------
  const startTelegram = async () => {
    setTgError(null);
    setTgBusy(true);
    try {
      const r = await apiRequest<{ deep_link: string; expires_at: string }>(
        '/verify/telegram/start',
        { method: 'POST' },
      );
      setTgLink(r.deep_link);
    } catch (err) {
      setTgError(err instanceof ApiError ? err.message : 'No pude generar el link.');
    } finally {
      setTgBusy(false);
    }
  };

  const unlinkTelegram = async () => {
    if (!confirm('¿Seguro que querés desvincular Telegram?')) return;
    setTgBusy(true);
    try {
      const s = await apiRequest<VerificationStatus>('/verify/telegram', { method: 'DELETE' });
      setStatus(s);
      setTgLink(null);
    } catch (err) {
      setTgError(err instanceof ApiError ? err.message : 'No pude desvincular.');
    } finally {
      setTgBusy(false);
    }
  };

  // ---------- Data export ----------
  const downloadExport = async () => {
    setExportBusy(true);
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/auth/me/export', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const today = new Date().toISOString().slice(0, 10);
      a.download = `campo-bot-export-${today}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`No pude descargar el export: ${(err as Error).message}`);
    } finally {
      setExportBusy(false);
    }
  };

  // ---------- Delete account ----------
  const confirmDelete = async () => {
    setDeleteError(null);
    if (!deletePassword) {
      setDeleteError('Ingresá tu contraseña actual para confirmar.');
      return;
    }
    setDeleteBusy(true);
    try {
      await apiRequest('/me', {
        method: 'DELETE',
        body: { password: deletePassword },
      });
      // Hard logout — token stays valid for the access window but the user is deleted.
      logout();
      navigate('/login');
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'No pude eliminar la cuenta.');
    } finally {
      setDeleteBusy(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-gray-500 dark:text-gray-300">Cargando…</div>;
  }

  function statusLabel(s: string): string {
    switch (s) {
      case 'trial': return 'En prueba gratis';
      case 'active': return 'Activa';
      case 'past_due': return 'Pago pendiente';
      case 'cancelled': return 'Cancelada';
      case 'expired': return 'Expirada';
      default: return s;
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">Mi cuenta</h2>
        <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">
          Vinculá tu WhatsApp y/o Telegram para usar el bot desde tus chats.
        </p>
      </div>

      {/* WhatsApp card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="text-3xl">💬</div>
            <div>
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">WhatsApp</h3>
              {status?.whatsapp_verified ? (
                <p className="text-sm text-green-700 mt-1">
                  ✅ Vinculado — <span className="font-mono">{status.phone_number}</span>
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">No vinculado</p>
              )}
            </div>
          </div>
          {status?.whatsapp_verified && (
            <div className="flex gap-3 items-center">
              <button
                onClick={() => { setWaStep('enter-phone'); setWaPhone(''); setWaError(null); }}
                disabled={waBusy}
                className="text-xs text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white disabled:opacity-50"
                title="Si perdiste acceso a este WhatsApp, vinculá un número nuevo"
              >
                Cambiar número
              </button>
              <button
                onClick={unlinkWhatsApp}
                disabled={waBusy}
                className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Desvincular
              </button>
            </div>
          )}
        </div>

        {!status?.whatsapp_verified && waStep === 'idle' && (
          <button
            onClick={() => setWaStep('enter-phone')}
            className="mt-4 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700"
          >
            Vincular WhatsApp
          </button>
        )}

        {waStep === 'enter-phone' && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
              Tu número de WhatsApp
            </label>
            <input
              type="tel"
              value={waPhone}
              onChange={e => setWaPhone(e.target.value)}
              placeholder="+54 9 11 1234 5678"
              className="w-full max-w-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
              disabled={waBusy}
            />
            <p className="text-xs text-gray-500 dark:text-gray-300">
              Te vamos a mandar un código de 6 dígitos a este número.
            </p>
            {waError && <p className="text-xs text-red-600">{waError}</p>}
            <div className="flex gap-2">
              <button
                onClick={startWhatsApp}
                disabled={waBusy}
                className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {waBusy ? 'Enviando…' : 'Enviar código'}
              </button>
              <button
                onClick={() => { setWaStep('idle'); setWaError(null); }}
                disabled={waBusy}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {waStep === 'enter-code' && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
              Pegá el código que te llegó por WhatsApp
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={waCode}
              onChange={e => setWaCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="w-32 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-lg tracking-widest text-center font-mono focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
              disabled={waBusy}
            />
            {waExpiresAt && (
              <p className="text-xs text-gray-500">
                El código vence el {new Date(waExpiresAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}.
              </p>
            )}
            {waError && <p className="text-xs text-red-600">{waError}</p>}
            <div className="flex gap-2">
              <button
                onClick={confirmWhatsApp}
                disabled={waBusy}
                className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {waBusy ? 'Verificando…' : 'Confirmar'}
              </button>
              <button
                onClick={() => { setWaStep('enter-phone'); setWaCode(''); setWaError(null); }}
                disabled={waBusy}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cambiar número
              </button>
            </div>
          </div>
        )}

        {waStep === 'success' && (
          <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-md">
            <p className="text-sm text-green-800 dark:text-green-300">✅ ¡Listo! Ya podés escribirle al bot por WhatsApp.</p>
          </div>
        )}
      </div>

      {/* Telegram card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="text-3xl">✈️</div>
            <div>
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">Telegram</h3>
              {status?.telegram_verified ? (
                <p className="text-sm text-green-700 mt-1">
                  ✅ Vinculado — <span className="font-mono">{status.telegram_id}</span>
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">No vinculado</p>
              )}
            </div>
          </div>
          {status?.telegram_verified && (
            <div className="flex gap-3 items-center">
              <button
                onClick={startTelegram}
                disabled={tgBusy}
                className="text-xs text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white disabled:opacity-50"
                title="Si perdiste acceso a este Telegram, generá un link nuevo"
              >
                Vincular otra cuenta
              </button>
              <button
                onClick={unlinkTelegram}
                disabled={tgBusy}
                className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Desvincular
              </button>
            </div>
          )}
        </div>

        {!status?.telegram_verified && (
          <div className="mt-4 space-y-3">
            {!tgLink ? (
              <button
                onClick={startTelegram}
                disabled={tgBusy}
                className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
              >
                {tgBusy ? 'Generando…' : 'Generar link de vinculación'}
              </button>
            ) : (
              <div className="space-y-2">
                <a
                  href={tgLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600"
                >
                  Abrir Telegram y vincular
                </a>
                <p className="text-xs text-gray-500 dark:text-gray-300">
                  Tocá el botón. Se abre Telegram, tocás "Iniciar" y la cuenta queda vinculada automáticamente.
                </p>
                <button
                  onClick={refreshStatus}
                  className="text-xs text-campo-600 hover:underline"
                >
                  Ya vinculé, refrescar estado
                </button>
              </div>
            )}
            {tgError && <p className="text-xs text-red-600">{tgError}</p>}
          </div>
        )}
      </div>

      {/* Subscription card */}
      {sub?.payments_enabled && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start gap-3">
            <div className="text-3xl">💳</div>
            <div className="flex-1">
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">Suscripción</h3>
              {sub.subscription ? (
                <div className="mt-2 space-y-1 text-sm">
                  <p className="text-gray-700 dark:text-gray-200">
                    Plan actual: <span className="font-medium">{sub.plan?.display_name ?? '—'}</span>
                  </p>
                  <p className="text-gray-500 dark:text-gray-300">
                    Estado: <span className={`font-medium ${
                      sub.subscription.status === 'active' ? 'text-green-700' :
                      sub.subscription.status === 'trial' ? 'text-blue-700' :
                      sub.subscription.status === 'past_due' ? 'text-amber-700' :
                      'text-gray-600'
                    }`}>{statusLabel(sub.subscription.status)}</span>
                  </p>
                  {sub.subscription.status === 'trial' && sub.subscription.trial_ends_at && (
                    <p className="text-blue-700">
                      Trial vence el {new Date(sub.subscription.trial_ends_at).toLocaleDateString('es-AR')}.
                    </p>
                  )}
                  {sub.subscription.current_period_end && (
                    <p className="text-gray-500">
                      Próximo cobro: {new Date(sub.subscription.current_period_end).toLocaleDateString('es-AR')}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-500 mt-1">Sin suscripción activa.</p>
              )}

              {(!sub.subscription || sub.subscription.status === 'trial' || sub.subscription.status === 'past_due') && sub.plan && sub.plan.price_ars > 0 && (
                <div className="mt-4 space-y-3">
                  <div className="flex gap-2 text-xs">
                    <button
                      onClick={() => setBillingPeriod('monthly')}
                      className={`px-3 py-1 rounded-full border ${billingPeriod === 'monthly' ? 'bg-campo-600 text-white border-campo-600' : 'bg-white dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600 text-gray-700 border-gray-300'}`}
                    >Mensual ${sub.plan.price_ars.toLocaleString('es-AR')}</button>
                    {sub.plan.price_ars_yearly && (
                      <button
                        onClick={() => setBillingPeriod('yearly')}
                        className={`px-3 py-1 rounded-full border ${billingPeriod === 'yearly' ? 'bg-campo-600 text-white border-campo-600' : 'bg-white text-gray-700 border-gray-300'}`}
                      >Anual ${sub.plan.price_ars_yearly.toLocaleString('es-AR')}</button>
                    )}
                  </div>
                  <button
                    onClick={() => upgradeNow(sub.plan!.name)}
                    disabled={subBusy}
                    className="px-4 py-2 bg-campo-600 text-white rounded-md text-sm font-medium hover:bg-campo-700 disabled:opacity-50"
                  >
                    {subBusy ? 'Redirigiendo…' : 'Pagar con MercadoPago'}
                  </button>
                </div>
              )}

              {sub.subscription && (sub.subscription.status === 'active' || sub.subscription.status === 'trial') && (
                <button
                  onClick={cancelSub}
                  disabled={subBusy}
                  className="mt-3 text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
                >
                  Cancelar suscripción
                </button>
              )}

              {subError && <p className="text-xs text-red-600 mt-2">{subError}</p>}
            </div>
          </div>
        </div>
      )}

      {/* Data export card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start gap-3">
          <div className="text-3xl">📦</div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-800 dark:text-gray-100">Exportar mis datos</h3>
            <p className="text-sm text-gray-500 mt-1">
              Descargá un ZIP con todo lo que registraste: campos, lotes, gastos, ingresos, actividades, observaciones, monitoreos, hacienda, stock, documentos. Un CSV por sección + un metadata.json con tu cuenta.
            </p>
            <button
              onClick={downloadExport}
              disabled={exportBusy}
              className="mt-3 px-4 py-2 bg-campo-600 text-white rounded-md text-sm font-medium hover:bg-campo-700 disabled:opacity-50"
            >
              {exportBusy ? 'Generando ZIP…' : 'Descargar ZIP'}
            </button>
          </div>
        </div>
      </div>

      {/* Danger zone */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-red-200 dark:border-red-800 p-6">
        <div className="flex items-start gap-3">
          <div className="text-3xl">⚠️</div>
          <div className="flex-1">
            <h3 className="font-semibold text-red-700">Eliminar mi cuenta</h3>
            <p className="text-sm text-gray-600 mt-1">
              Tu cuenta se marca como eliminada y se desvinculan WhatsApp/Telegram. Tus datos quedan 30 días por si te arrepentís, después se borran definitivamente. Recomendamos descargar el export antes.
            </p>

            {!deleteOpen ? (
              <button
                onClick={() => setDeleteOpen(true)}
                className="mt-3 px-4 py-2 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 rounded-md text-sm font-medium hover:bg-red-50 dark:hover:bg-red-900/30"
              >
                Eliminar mi cuenta
              </button>
            ) : (
              <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md space-y-3">
                <p className="text-sm text-red-800 dark:text-red-300 font-medium">
                  Esta acción es definitiva. Confirmá con tu contraseña actual.
                </p>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={e => setDeletePassword(e.target.value)}
                  placeholder="Contraseña actual"
                  className="w-full max-w-xs border border-red-300 dark:border-red-700 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none"
                  disabled={deleteBusy}
                />
                {deleteError && <p className="text-xs text-red-700">{deleteError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={confirmDelete}
                    disabled={deleteBusy}
                    className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                  >
                    {deleteBusy ? 'Eliminando…' : 'Confirmar eliminación'}
                  </button>
                  <button
                    onClick={() => { setDeleteOpen(false); setDeletePassword(''); setDeleteError(null); }}
                    disabled={deleteBusy}
                    className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
