import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AccountDataSection from './AccountDataSection';
import { Pencil, X, Check, Lock } from 'lucide-react';
import LocalidadInput from './LocalidadInput';
import { apiRequest, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import PlanChooser from './billing/PlanChooser';
import {
  fetchSubscription,
  startCheckout,
  daysUntil,
  type BillingPeriod,
  type SubscriptionStatus,
} from '../api/subscription';
import { PATHS } from '../paths';
import ChannelCards from './ChannelCards';

// Los tipos de suscripción viven en api/subscription.ts — los tenía duplicados
// este componente y el banner del Resumen, y ya diferían entre sí.


export default function ChannelLinking() {
  const [loading, setLoading] = useState(true);



  // Subscription state
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // Perfil editable
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileLastName, setProfileLastName] = useState('');
  const [profileCity, setProfileCity] = useState('');
  const [profileEmail, setProfileEmail] = useState('');
  const [profileEmailPassword, setProfileEmailPassword] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState(false);
  // Local shadow of user profile (refreshed after save)
  const [localUser, setLocalUser] = useState<{ name: string | null; last_name: string | null; city: string | null; email: string | null } | null>(null);

  useEffect(() => {
    if (user) {
      setLocalUser({ name: user.name, last_name: user.last_name ?? null, city: user.city, email: user.email });
    }
  }, [user]);


  const refreshSub = async () => {
    try {
      setSub(await fetchSubscription());
    } catch {
      // ignore (e.g. payments_enabled=false → endpoint still returns)
    }
  };

  useEffect(() => {
    refreshSub().finally(() => setLoading(false));
  }, []);


  // ---------- Subscription ----------
  const upgradeNow = async (planName: string, period: BillingPeriod) => {
    setSubError(null);
    setSubBusy(true);
    try {
      window.location.href = await startCheckout(planName, period);
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

  // ---------- Cambio de contraseña ----------
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwRepeat, setPwRepeat] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwModalOpen, setPwModalOpen] = useState(false);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (logoutTimerRef.current !== null) clearTimeout(logoutTimerRef.current);
    };
  }, []);

  const changePassword = async () => {
    setPwError(null);
    if (pwNew.length < 8) {
      setPwError('La nueva contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (pwNew !== pwRepeat) {
      setPwError('Las contraseñas no coinciden.');
      return;
    }
    setPwBusy(true);
    try {
      await apiRequest('/me/password', {
        method: 'POST',
        body: { currentPassword: pwCurrent, newPassword: pwNew },
      });
      setPwSuccess(true);
      setPwCurrent('');
      setPwNew('');
      setPwRepeat('');
      logoutTimerRef.current = setTimeout(() => {
        logout();
        navigate(PATHS.login);
      }, 2000);
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : 'No pude cambiar la contraseña.');
    } finally {
      setPwBusy(false);
    }
  };

  // ---------- Perfil ----------
  const startEditProfile = () => {
    setProfileName(localUser?.name ?? '');
    setProfileLastName(localUser?.last_name ?? '');
    setProfileCity(localUser?.city ?? '');
    setProfileEmail(localUser?.email ?? '');
    setProfileError(null);
    setProfileSuccess(false);
    setProfileEditing(true);
  };

  const cancelEditProfile = () => {
    setProfileEditing(false);
    setProfileError(null);
  };

  const saveProfile = async () => {
    setProfileError(null);
    setProfileBusy(true);
    try {
      const body: Record<string, string> = {};
      if (profileName !== (localUser?.name ?? '')) body.name = profileName;
      if (profileLastName !== (localUser?.last_name ?? '')) body.last_name = profileLastName;
      if (profileCity !== (localUser?.city ?? '')) body.city = profileCity;
      if (profileEmail !== (localUser?.email ?? '')) {
        body.email = profileEmail;
        body.current_password = profileEmailPassword;
      }
      if (Object.keys(body).length === 0) { setProfileEditing(false); return; }
      const result = await apiRequest<{ user: { id: number; name: string | null; last_name: string | null; city: string | null; email: string | null } }>(
        '/me',
        { method: 'PATCH', body },
      );
      setLocalUser({ name: result.user.name, last_name: result.user.last_name ?? null, city: result.user.city, email: result.user.email });
      setProfileSuccess(true);
      setProfileEmailPassword('');
      setProfileEditing(false);
      setTimeout(() => setProfileSuccess(false), 3000);
    } catch (err) {
      setProfileError(err instanceof ApiError ? err.message : 'No pude guardar los cambios.');
    } finally {
      setProfileBusy(false);
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

      {/* Tu perfil card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="text-3xl">👤</div>
            <div>
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">Tu perfil</h3>
              <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">Nombre, ciudad y email de tu cuenta.</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => { setPwCurrent(''); setPwNew(''); setPwRepeat(''); setPwError(null); setPwModalOpen(true); }}
              className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white transition-colors"
              title="Cambiar contraseña"
            >
              <Lock className="w-4 h-4" />
              <span className="hidden sm:inline">Contraseña</span>
            </button>
            {!profileEditing && (
              <button
                type="button"
                onClick={startEditProfile}
                className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white transition-colors"
                title="Editar perfil"
              >
                <Pencil className="w-4 h-4" />
                <span className="hidden sm:inline">Editar</span>
              </button>
            )}
          </div>
        </div>

        {profileSuccess && (
          <div className="mt-3 flex items-center gap-2 text-green-700 dark:text-green-400 text-sm">
            <Check className="w-4 h-4" />
            Perfil actualizado correctamente.
          </div>
        )}

        {!profileEditing ? (
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex gap-2">
              <dt className="w-20 text-gray-500 dark:text-gray-400 shrink-0">Nombre</dt>
              <dd className="text-gray-800 dark:text-gray-100">{localUser?.name || <span className="italic text-gray-400">—</span>}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 text-gray-500 dark:text-gray-400 shrink-0">Apellido</dt>
              <dd className="text-gray-800 dark:text-gray-100">{localUser?.last_name || <span className="italic text-gray-400">—</span>}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 text-gray-500 dark:text-gray-400 shrink-0">Ciudad</dt>
              <dd className="text-gray-800 dark:text-gray-100">{localUser?.city || <span className="italic text-gray-400">—</span>}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 text-gray-500 dark:text-gray-400 shrink-0">Email</dt>
              <dd className="text-gray-800 dark:text-gray-100 font-mono text-xs">{localUser?.email || <span className="italic text-gray-400">—</span>}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 text-gray-500 dark:text-gray-400 shrink-0">Teléfono</dt>
              <dd className="text-gray-500 dark:text-gray-400 italic text-xs">Se cambia desde la card de WhatsApp, más abajo.</dd>
            </div>
          </dl>
        ) : (
          <div className="mt-4 space-y-3 max-w-sm">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Nombre</label>
              <input
                type="text"
                value={profileName}
                onChange={e => setProfileName(e.target.value)}
                disabled={profileBusy}
                placeholder="Tu nombre"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Apellido</label>
              <input
                type="text"
                value={profileLastName}
                onChange={e => setProfileLastName(e.target.value)}
                disabled={profileBusy}
                placeholder="Tu apellido"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Ciudad</label>
              <LocalidadInput
                value={profileCity}
                onChange={setProfileCity}
                disabled={profileBusy}
                placeholder="Tu localidad (para el clima y las alertas)"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Se usa para darte el clima y las alertas de tu zona.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Email</label>
              <input
                type="email"
                value={profileEmail}
                onChange={e => setProfileEmail(e.target.value)}
                disabled={profileBusy}
                placeholder="tu@email.com"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
              />
              {profileEmail !== (localUser?.email ?? '') && (
                <>
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    ⚠️ Si cambiás el email, vas a tener que verificarlo de nuevo.
                  </p>
                  <label htmlFor="profile-email-password" className="block text-xs font-medium text-gray-600 dark:text-gray-300 mt-2 mb-1">Contraseña actual</label>
                  <input
                    id="profile-email-password"
                    type="password"
                    autoComplete="current-password"
                    value={profileEmailPassword}
                    onChange={e => setProfileEmailPassword(e.target.value)}
                    disabled={profileBusy}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                  />
                </>
              )}
            </div>
            {profileError && <p className="text-red-600 dark:text-red-400 text-xs">{profileError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveProfile}
                disabled={profileBusy}
                className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-campo-600 hover:bg-campo-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >
                <Check className="w-4 h-4" />
                {profileBusy ? 'Guardando…' : 'Guardar'}
              </button>
              <button
                type="button"
                onClick={cancelEditProfile}
                disabled={profileBusy}
                className="flex items-center gap-1.5 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                <X className="w-4 h-4" />
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>


      {/* Modal de cambio de contraseña (se abre desde Tu perfil) */}
      {pwModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
                  <Lock className="w-5 h-5 text-campo-600 dark:text-campo-400" />
                  Cambiar contraseña
                </h3>
                <button
                  onClick={() => setPwModalOpen(false)}
                  disabled={pwBusy}
                  className="text-gray-400 dark:text-gray-300 hover:text-gray-600 dark:hover:text-gray-100 text-xl leading-none disabled:opacity-50"
                >&times;</button>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-300 mb-4">Tu contraseña de acceso al dashboard.</p>
              {pwSuccess ? (
                <p className="text-green-700 dark:text-green-400 text-sm font-medium">
                  ✅ Contraseña actualizada. Vas a tener que iniciar sesión de nuevo.
                </p>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Contraseña actual</label>
                    <input
                      type="password"
                      value={pwCurrent}
                      onChange={e => setPwCurrent(e.target.value)}
                      disabled={pwBusy}
                      placeholder="Tu contraseña actual"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Nueva contraseña</label>
                    <input
                      type="password"
                      value={pwNew}
                      onChange={e => setPwNew(e.target.value)}
                      disabled={pwBusy}
                      placeholder="Mínimo 8 caracteres"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Repetir nueva contraseña</label>
                    <input
                      type="password"
                      value={pwRepeat}
                      onChange={e => setPwRepeat(e.target.value)}
                      disabled={pwBusy}
                      placeholder="Repetí la nueva contraseña"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                    />
                  </div>
                  {pwError && <p className="text-red-600 dark:text-red-400 text-xs">{pwError}</p>}
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={changePassword}
                      disabled={pwBusy || !pwCurrent || !pwNew || !pwRepeat}
                      className="px-4 py-2 rounded-md bg-campo-600 hover:bg-campo-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      {pwBusy ? 'Cambiando…' : 'Cambiar contraseña'}
                    </button>
                    <button
                      onClick={() => setPwModalOpen(false)}
                      disabled={pwBusy}
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
      )}

      {/* Canales: WhatsApp + Telegram lado a lado en desktop */}
      <ChannelCards />

      {/* Subscription card */}
      {sub?.payments_enabled && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          {/* Header con gradiente + badge de estado */}
          <div className="bg-gradient-to-r from-campo-600 to-campo-800 px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center text-xl">💳</div>
              <div>
                <h3 className="font-semibold text-white leading-tight">Suscripción</h3>
                <p className="text-campo-100 text-sm">
                  {sub.plan ? `Plan ${sub.plan.display_name}` : 'Sin plan activo'}
                </p>
              </div>
            </div>
            {sub.subscription && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/15 text-white text-xs font-medium backdrop-blur-sm">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  sub.subscription.status === 'active' ? 'bg-green-300' :
                  sub.subscription.status === 'trial' ? 'bg-sky-300' :
                  sub.subscription.status === 'past_due' ? 'bg-amber-300' :
                  'bg-gray-300'
                }`} />
                {statusLabel(sub.subscription.status)}
              </span>
            )}
          </div>

          <div className="p-6 space-y-4">
            {/* Estado: prueba, próximo cobro, o vencida */}
            {sub.subscription?.status === 'trial' && sub.subscription.trial_ends_at && (() => {
              const daysLeft = Math.max(0, daysUntil(sub.subscription!.trial_ends_at!));
              return (
                <div className="flex items-center gap-2.5 rounded-lg bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-800 px-4 py-3 text-sm text-sky-800 dark:text-sky-200">
                  <span className="text-lg">⏳</span>
                  <span>
                    Te quedan <span className="font-semibold">{daysLeft} {daysLeft === 1 ? 'día' : 'días'}</span> de prueba gratis
                    {' '}(hasta el {new Date(sub.subscription!.trial_ends_at!).toLocaleDateString('es-AR')}).
                  </span>
                </div>
              );
            })()}
            {sub.access_mode === 'trial_expired_readonly' && (
              <div className="flex items-center gap-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
                <span className="text-lg">🔒</span>
                <span>
                  Tu prueba terminó. Elegí un plan para volver a usar el bot y el panel —
                  tus datos siguen guardados.
                </span>
              </div>
            )}
            {sub.subscription?.status === 'active' && sub.subscription.current_period_end && (
              <p className="text-sm text-gray-500 dark:text-gray-300">
                Próximo cobro: {new Date(sub.subscription.current_period_end).toLocaleDateString('es-AR')}
              </p>
            )}
            {!sub.subscription && (
              <p className="text-sm text-gray-500 dark:text-gray-300">Sin suscripción activa.</p>
            )}

            {/* Planes comprables. Se muestran salvo que la suscripción esté al
                día: alguien en prueba, vencido, cancelado o con el pago rebotado
                tiene que poder pagar desde acá. La condición vieja dejaba fuera
                'expired' y 'cancelled' — justo los dos estados en los que el
                usuario ENTRA a esta pantalla para pagar. */}
            {sub.subscription?.status !== 'active' && (
              <PlanChooser
                plans={sub.plans}
                currentPlanName={
                  sub.subscription?.status === 'trial' ? sub.plan?.name ?? null : null
                }
                supportContact={sub.support_contact}
                busy={subBusy}
                onCheckout={upgradeNow}
              />
            )}

            {subError && <p className="text-xs text-red-600 mt-2">{subError}</p>}

            {sub.subscription && (sub.subscription.status === 'active' || sub.subscription.status === 'trial') && (
              <div className="pt-3 border-t border-gray-100 dark:border-gray-700">
                <button
                  onClick={cancelSub}
                  disabled={subBusy}
                  className="text-xs text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 transition-colors"
                >
                  Cancelar suscripción
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Guía de uso (visible también en mobile, donde no hay Sidebar) */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start gap-3">
          <div className="text-3xl">📖</div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-800 dark:text-gray-100">Guía de uso</h3>
            <p className="text-sm text-gray-500 mt-1">
              Todo lo que le podés decir al bot, con ejemplos para copiar: gastos, labores, hacienda, recordatorios y más.
            </p>
            <a
              href="/guia"
              target="_blank"
              rel="noopener"
              className="inline-block mt-3 px-4 py-2 border border-campo-600 text-campo-700 dark:text-campo-400 rounded-md text-sm font-medium hover:bg-campo-50 dark:hover:bg-campo-900/30"
            >
              Ver la guía completa
            </a>
          </div>
        </div>
      </div>

      <AccountDataSection />
    </div>
  );
}
